import type {
  BalanceEntry,
  ChainFamily,
  ChainSpec,
  FeeEstimate,
  NormalizedBlock,
  NormalizedTx,
  UnsignedTx,
} from './types.js';

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

export interface ContractReadParams {
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

  getNativeBalance(chain: ChainSpec, address: string): Promise<BalanceEntry>;
  getTokenBalances(chain: ChainSpec, address: string, tokens?: string[]): Promise<BalanceEntry[]>;
  getTransaction(chain: ChainSpec, hash: string): Promise<NormalizedTx>;
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
