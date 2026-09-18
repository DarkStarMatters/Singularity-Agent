import type { Completeness } from './envelope.js';
import type {
  BalanceEntry,
  ChainFamily,
  ChainSpec,
  FeeEstimate,
  HistoryEntry,
  NormalizedBlock,
  NormalizedTx,
  UnsignedTx,
} from './types.js';

/**
 * A token scan and the account it gives of itself.
 *
 * `completeness` is required, and there is deliberately no way to return a bare
 * array instead. An empty array reads as "this wallet holds nothing" to
 * everything downstream, and it is the same empty array whether that is true,
 * whether nine tokens out of thousands were checked, or whether every call
 * failed. Making the adapter say which one closes that gap at the type level
 * rather than in a comment someone has to remember.
 */
export interface TokenScan {
  entries: BalanceEntry[];
  completeness: Completeness;
}

/**
 * What an address has been doing, and how much of it this list represents.
 *
 * Read the completeness before the entries. "No activity" and "this chain
 * cannot tell you" are different answers that look identical once both are an
 * empty array, and the second one is the common case: EVM history needs an
 * indexer, which needs a key somebody may not have configured. An adapter that
 * cannot answer returns `kind: 'failed'` with a note naming what to configure,
 * and never an empty list.
 */
export interface TransactionHistory {
  chain: string;
  address: string;
  entries: HistoryEntry[];
  completeness: Completeness;
  /**
   * Opaque continuation token for the next page, when more exists. Its shape is
   * the adapter's business — a Solana signature, an Esplora txid, a Cosmos page
   * number — and callers pass it back rather than interpreting it.
   */
  cursor?: string;
}

export interface HistoryOptions {
  /** How many entries to return. Adapters cap this; the cap is reported. */
  limit?: number;
  /** A `cursor` from a previous call. */
  cursor?: string;
}

export interface TransferParams {
  /** Sender. Required on UTXO (coin selection) and Cosmos (account number). */
  from?: string;
  to: string;
  /** Human decimal string, e.g. "1.5". Never base units — that's a footgun. */
  amount: string;
  /** Token contract / mint / denom. Omit for the chain's native asset. */
  token?: string;
  /** Optional memo, where the chain supports one (Cosmos). */
  memo?: string;
}

/**
 * When to read state.
 *
 * Passed to every state-reading call. An adapter that cannot honour `atBlock`
 * must throw — ignoring it and answering with current state is the one bug
 * class that produces a confidently wrong answer with no visible symptom.
 */
export interface StateOptions {
  /** Block height / slot to read at. Absent means current state. */
  atBlock?: number;
}

export interface ContractReadParams extends StateOptions {
  /** Contract address (EVM) or account/program address (SVM). */
  address: string;
  /** EVM: function name. Ignored on other families. */
  method?: string;
  /** EVM: human-readable ABI entry, e.g. "function balanceOf(address) view returns (uint256)". */
  abi?: string;
  args?: unknown[];
}

/**
 * Every family implements the same surface. Anything a family genuinely cannot
 * do throws UnsupportedOperationError rather than returning a fake empty
 * result — a silent [] reads as "no tokens" and gets reported as fact.
 */
export interface ChainAdapter {
  readonly family: ChainFamily;

  /** Shape check only — no network call. */
  isValidAddress(chain: ChainSpec, address: string): boolean;
  /**
   * Human explanation of the expected format, used in error hints. The
   * offending address is passed in so an adapter can tailor the advice — a
   * Cosmos address with the wrong prefix gets the corrected one back.
   */
  addressExpectation(chain: ChainSpec, address?: string): string;

  getNativeBalance(
    chain: ChainSpec,
    address: string,
    options?: StateOptions,
  ): Promise<BalanceEntry>;
  /**
   * Token holdings for an address, with a statement of what the list covers.
   *
   * Every return says which kind of list it is — see {@link TokenScan}. A
   * family that cannot enumerate at all still answers here rather than
   * throwing, with `completeness.kind === 'curated'` or `'failed'`, because
   * "nothing was checked" is an answer and an exception is not.
   */
  getTokenBalances(
    chain: ChainSpec,
    address: string,
    tokens?: string[],
    options?: StateOptions,
  ): Promise<TokenScan>;
  getTransaction(chain: ChainSpec, hash: string): Promise<NormalizedTx>;
  /**
   * What this address has been doing, most recent first.
   *
   * Optional because the ability is not universal and pretending otherwise is
   * how an empty array comes to mean two different things. An adapter that
   * implements it must still answer when it cannot help — `completeness.failed`
   * naming the missing configuration — rather than returning nothing or
   * throwing. A family that does not implement it at all is reported as
   * unsupported by the caller, which is a third distinct answer.
   */
  getHistory?(
    chain: ChainSpec,
    address: string,
    options?: HistoryOptions,
  ): Promise<TransactionHistory>;
  getBlock(chain: ChainSpec, ref: string | number): Promise<NormalizedBlock>;
  estimateFees(chain: ChainSpec): Promise<FeeEstimate>;
  buildTransfer(chain: ChainSpec, params: TransferParams): Promise<UnsignedTx>;

  /**
   * Cheapest call that proves the endpoint is serving this chain.
   *
   * Defaults to fetching the latest block, but some families restrict that on
   * public endpoints — Solana disables `getBlock` while serving reads fine — so
   * an adapter can offer a lighter probe and avoid reporting a working endpoint
   * as down.
   */
  healthCheck?(chain: ChainSpec): Promise<void>;

  /** Name service lookup (ENS, SNS, …). Returns null when unresolvable. */
  resolveName?(chain: ChainSpec, name: string): Promise<string | null>;
  /** Reverse lookup: address -> primary name. */
  lookupName?(chain: ChainSpec, address: string): Promise<string | null>;
  readContract?(chain: ChainSpec, params: ContractReadParams): Promise<unknown>;
}
