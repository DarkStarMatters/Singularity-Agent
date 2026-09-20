/**
 * Types the SDK re-exports from the agent core.
 *
 * One import site rather than thirty. An application built on this package
 * should never need to depend on `singularity-agent` directly — if it does,
 * that is a gap in this file, not a thing to work around.
 *
 * `Completeness` is the one to read first. Every list-shaped result in this SDK
 * carries one, and it is the difference between "this wallet holds nothing" and
 * "nothing was checked" — two answers that are the same empty array.
 */

export type {
  Amount,
  BalanceEntry,
  BalanceResult,
  BurnClaim,
  BurnEvent,
  BurnReceipt,
  ChainAdapter,
  ChainFamily,
  ChainLiveness,
  ChainSpec,
  ChainSummary,
  ChainTip,
  Completeness,
  CompletenessKind,
  ContractReadParams,
  DecodedArg,
  DecodedCall,
  DecodedEvent,
  DeclaredAccount,
  EndpointHealthResult,
  EndpointProbe,
  FeeEstimate,
  Finality,
  FinalityKind,
  HistoryEntry,
  LivenessStatus,
  MintAudit,
  MintPower,
  MintPowerKind,
  NativeCurrency,
  NormalizedBlock,
  NormalizedTx,
  PortfolioResult,
  ResolvedIdentity,
  ResponseBudget,
  SelectorCandidate,
  TokenExitReport,
  TokenIdentity,
  TokenRef,
  TokenScan,
  ExitMechanism,
  ExitRisk,
  Concentration,
  TransactionHistory,
  TransferParams,
  UnsignedTx,
} from 'singularity-agent';
