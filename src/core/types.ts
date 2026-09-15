/**
 * Normalized cross-chain types.
 *
 * The whole point of Singularity is that a balance on Bitcoin and a balance on
 * Osmosis come back in the *same shape*, so an agent (or a human at a terminal)
 * never has to learn four sets of field names.
 */

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
}

export interface BalanceEntry {
  chain: string;
  address: string;
  token: TokenRef;
  amount: Amount;
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
  /** Human-readable summary line, e.g. "Transfer 1.5 ETH -> 0xabc…". */
  summary: string;
  /** Decoded call, when we could work it out. */
  decoded?: DecodedCall;
  explorerUrl?: string;
  /** Anything chain-specific that did not fit the normalized shape. */
  raw?: Record<string, unknown>;
}

export interface DecodedCall {
  /** e.g. "transfer(address,uint256)". */
  signature?: string;
  name?: string;
  selector?: string;
  args?: Array<{ name?: string; type?: string; value: string }>;
  /** Set when we could not identify the call. */
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
