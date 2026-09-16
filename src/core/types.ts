/**
 * Normalized cross-chain types.
 *
 * The whole point of Singularity is that a balance on Bitcoin and a balance on
 * Osmosis come back in the *same shape*, so an agent (or a human at a terminal)
 * never has to learn four sets of field names.
 */

import type { Impersonation } from './impersonation.js';
import type { UntrustedText } from './envelope.js';

export type ChainFamily = 'evm' | 'svm' | 'utxo' | 'cosmos';

export interface NativeCurrency {
  name: string;
  symbol: string;
  decimals: number;
}

export interface ChainSpec {
  /** Canonical slug used everywhere in this tool, e.g. "base", "solana". */
  id: string;
  name: string;
  family: ChainFamily;
  /** Numeric chain id for EVM; chain-id string for Cosmos; undefined otherwise. */
  chainId?: number | string;
  nativeCurrency: NativeCurrency;
  /** Ordered endpoints; the first reachable one wins. */
  rpc: string[];
  explorer?: string;
  testnet?: boolean;
  /** Cosmos bech32 account prefix, e.g. "cosmos", "osmo". */
  bech32Prefix?: string;
  /** Cosmos base denom, e.g. "uatom". */
  denom?: string;
  /** Free-form aliases accepted on the CLI / in tool args. */
  aliases?: string[];
}

/** A quantity expressed in both raw base units and human decimal form. */
export interface Amount {
  /** Base units as a decimal string (wei, lamports, satoshi, uatom). */
  raw: string;
  /** Human-readable decimal string, e.g. "1.2345". */
  formatted: string;
  decimals: number;
  symbol: string;
}

export interface TokenRef {
  /** Contract address / mint / denom. Absent for the native asset. */
  address?: string;
  symbol: string;
  name?: string;
  decimals: number;
  /** True for ETH, SOL, BTC, ATOM — the chain's gas asset. */
  native: boolean;
  /**
   * The symbol and name were read from the chain, so whoever deployed the
   * contract chose them.
   *
   * Set when the token is not in the curated list. A token whose `symbol()`
   * returns a sentence aimed at whatever reads it next costs about ten dollars
   * to deploy; the value here has already been stripped of anything that could
   * forge structure, and this flag tells a consumer to render it inertly and
   * never act on it. Absent means the text came from this tool's own token
   * map, which is as trustworthy as the tool.
   */
  untrusted?: true;
  /**
   * The symbol above is the symbol of a *different* known asset.
   *
   * `untrusted` says the deployer chose this string; this says the string they
   * chose already belongs to something else on this chain. Fake tokens reusing
   * a real ticker is the most common retail loss there is, and the difference
   * between the two is forty-two hex characters nobody compares by eye.
   *
   * Present only when the collision is real — see `checkImpersonation`. Absent
   * means nothing was found, which is not a clean bill of health: a token can
   * be a fraud without colliding with anything this tool curates.
   */
  impersonation?: Impersonation;
}

export interface BalanceEntry {
  chain: string;
  address: string;
  token: TokenRef;
  amount: Amount;
  /**
   * How many on-chain accounts this entry sums, when more than one. Solana
   * wallets can hold several token accounts for a single mint; `amount` is the
   * total across them.
   */
  tokenAccounts?: number;
  /**
   * Block height / slot this balance was read at. Absent means current state.
   * Present only when a historical read was asked for *and* served — it is
   * never filled in speculatively, because a caller comparing two answers has
   * to be able to tell which one is actually historical.
   */
  atBlock?: number;
}

export interface NormalizedTx {
  chain: string;
  hash: string;
  status: 'success' | 'failed' | 'pending' | 'unknown';
  blockNumber?: number;
  timestamp?: string;
  from?: string;
  to?: string;
  value?: Amount;
  fee?: Amount;
  /**
   * Human-readable summary line, e.g. "Transfer 1.5 ETH -> 0xabc…".
   *
   * Written entirely by this tool. Nothing read off the chain is interpolated
   * into it — that is what `memo`, `failureLog` and `logs` below are for. The
   * rule is worth stating because breaking it is invisible: a summary with a
   * sender's memo spliced into the middle still type-checks, still reads
   * fluently, and is the tool putting an attacker's sentence in its own voice.
   */
  summary: string;
  /** Decoded call, when we could work it out. */
  decoded?: DecodedCall;
  /**
   * Free text the sender attached to the transaction (Cosmos memo).
   *
   * Whoever sent the transaction wrote this and chose every character of it.
   * Absent means the transaction carried none.
   */
  memo?: UntrustedText;
  /**
   * The chain's own account of why this transaction failed.
   *
   * A revert string is written by the contract that reverted, which on a failed
   * transaction is very often the contract the user was warned about.
   */
  failureLog?: UntrustedText;
  /**
   * Log output the executing programs emitted (Solana).
   *
   * A program may log anything it likes, at whatever length it likes, including
   * text shaped exactly like this tool's own output.
   */
  logs?: UntrustedText[];
  /**
   * Decoded receipt logs (EVM).
   *
   * Distinct from `logs` above, and the distinction is not cosmetic: a Solana
   * program log is free text somebody wrote, while these are structured events
   * whose shape the ABI fixes. One is prose to be distrusted, the other is
   * evidence of what the transaction did.
   */
  events?: DecodedEvent[];
  explorerUrl?: string;
  /** Anything chain-specific that did not fit the normalized shape. */
  raw?: Record<string, unknown>;
}

/** One decoded argument. Split out because nested calls carry them too. */
export interface DecodedArg {
  name?: string;
  type?: string;
  value: string;
  /**
   * This argument's value is text somebody chose, not a number or an address.
   *
   * Most decoded arguments cannot carry prose — a `uint256` is digits and an
   * `address` is twenty bytes of hex, and neither can be made to read as an
   * instruction. A `string` can, and calldata is authored by whoever sent the
   * transaction. Set whenever the argument's type carries text *or the type
   * is unknown*, because an argument whose provenance cannot be established
   * is exactly the one to distrust.
   */
  untrusted?: true;
}

/**
 * A signature offered by a public 4-byte directory.
 *
 * Kept apart from `signature` on purpose, and that separation is the whole
 * point of the field. `signature` means *this tool recognized the call*. A
 * directory entry means *somebody submitted this text for this selector*, and
 * anybody may submit: a selector is four bytes of a hash, collisions are
 * cheap to manufacture, and a plausible wrong signature decodes a transfer
 * into something that reads as harmless. So it arrives marked, named as
 * third-party, and never promoted into `signature`.
 */
export interface SelectorCandidate {
  /** The signature text exactly as the directory serves it, sanitized. */
  signature: string;
  untrusted: true;
  /**
   * Arguments decoded against this candidate.
   *
   * Present only when it was the *sole* candidate that decoded cleanly. With
   * two that both decode there is no evidence for either, and picking one
   * would be the guess this tool exists not to make.
   */
  args?: DecodedArg[];
}

export interface DecodedCall {
  /** e.g. "transfer(address,uint256)". */
  signature?: string;
  name?: string;
  selector?: string;
  args?: DecodedArg[];
  /** Set when we could not identify the call. */
  note?: string;
  /**
   * The address this call was aimed at, when the call that wrapped it said so.
   *
   * Only meaningful on a nested call: a Multicall3 batch and a Safe
   * `execTransaction` both name their target, and a batch that hides which
   * contract each leg hits is a batch nobody can review.
   */
  target?: string;
  /**
   * Calls carried inside this one's arguments.
   *
   * A `multicall`, a Multicall3 `aggregate`, a Safe `execTransaction` or a
   * `multiSend` is a wrapper: the thing it actually does is in a `bytes`
   * argument, and reporting "multicall(bytes[])" while leaving that opaque
   * tells a reviewer nothing they did not already know from the selector.
   */
  inner?: DecodedCall[];
  /**
   * Third-party guesses at this selector, when nothing local matched and the
   * caller asked for a directory lookup. Never a substitute for `signature`.
   */
  candidates?: SelectorCandidate[];
}

/**
 * A log entry from a receipt, decoded.
 *
 * Calldata says what was *asked for*; logs say what happened. On a transaction
 * that routed through an aggregator those are different answers, and the
 * second one is usually the question.
 */
export interface DecodedEvent {
  /** The contract that emitted it. */
  address: string;
  /** e.g. "Transfer(address,address,uint256)", when recognized. */
  signature?: string;
  name?: string;
  /** topics[0], always present — the one thing a log cannot hide. */
  topic: string;
  args?: DecodedArg[];
  /** Set when the event could not be identified. */
  note?: string;
}

export interface NormalizedBlock {
  chain: string;
  number: number;
  hash: string;
  timestamp?: string;
  txCount: number;
  parentHash?: string;
  explorerUrl?: string;
  raw?: Record<string, unknown>;
}

export interface FeeEstimate {
  chain: string;
  /** Normalized "what a simple transfer costs right now", in native units. */
  simpleTransfer?: Amount;
  /** Chain-specific fee knobs, already formatted for humans. */
  details: Record<string, string>;
  note?: string;
}

/**
 * An unsigned transaction. Singularity never signs and never holds a key —
 * it hands back a payload for the user's own wallet.
 */
export interface UnsignedTx {
  chain: string;
  family: ChainFamily;
  /** What this transaction will do, in one sentence, for human review. */
  summary: string;
  /** The payload shape a wallet on this family expects. */
  payload: Record<string, unknown>;
  /** How to actually sign and send this. */
  signingHint: string;
  warnings: string[];
}

export interface ResolvedIdentity {
  input: string;
  /** What we think the input is. */
  kind: 'address' | 'name' | 'tx' | 'block' | 'unknown';
  address?: string;
  /** Human-readable name, e.g. an ENS or SNS name. */
  name?: string;
  /** Chains this identity is valid on. */
  chains: string[];
  family?: ChainFamily;
  /**
   * The same account expressed on other chains, where that is meaningful.
   * Cosmos re-encodes one key per chain prefix, so cosmos1… and osmo1… are the
   * same account and pasting the wrong one is a common, confusing mistake.
   */
  equivalents?: Record<string, string>;
  note?: string;
}
