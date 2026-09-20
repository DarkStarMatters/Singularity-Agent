/** Library entry point — the same operations the CLI and MCP server use. */
export * from './core/types.js';
export * from './core/errors.js';
export { allChains, getChain, chainsByFamily, loadUserConfig, resetRegistry } from './core/registry.js';
export { BUILTIN_CHAINS, DEFAULT_PORTFOLIO_CHAINS } from './core/chains.js';
export { detect } from './core/detect.js';
export { formatUnits, parseUnits, amount, explorerUrl } from './core/format.js';
export { decodeCalldata, decodeWithAbi } from './core/abi.js';
export { adapterFor, adapterForFamily } from './adapters/index.js';
export type { ChainAdapter, TransferParams, ContractReadParams } from './core/adapter.js';
export * as operations from './tools/operations.js';
export { createServer } from './mcp/server.js';
export { VERSION } from './version.js';

/**
 * The vocabulary a result describes itself in.
 *
 * These lived one directory below the export surface until v0.1.0, which meant
 * a library consumer could receive a `Completeness` on every list-shaped result
 * and have no way to name its type without reaching past `exports` into
 * `dist/`. A caveat you cannot type is one you end up not handling, which is
 * the failure this project has now shipped three times. `singularity-sdk`
 * needed them first; anything building on the library needs them too.
 */
export type { Completeness, CompletenessKind } from './core/envelope.js';
export { completeness } from './core/envelope.js';
export type { ResponseBudget, BudgetBounds } from './core/budget.js';
export { applyBudget, itemBudget, parseBudget } from './core/budget.js';
export type { TokenScan, TransactionHistory, HistoryOptions, ScanOptions, StateOptions } from './core/adapter.js';
export type { ChainLiveness, ChainTip, EndpointProbe, LivenessStatus } from './core/liveness.js';
export { describeAge, isDegraded } from './core/liveness.js';

/**
 * Polling. One loop, shared by `singularity watch` and `singularity-sdk`,
 * because the dependency only runs one way and two loops would be two sets of
 * backoff semantics. Read the note in `core/watch.ts` on what a poll can and
 * cannot see before building on it.
 */
export { pollLoop } from './core/watch.js';
export type { Change, Handler, PollOptions, Subscription, WatchOptions } from './core/watch.js';
export type { Finality, FinalityKind } from './core/finality.js';
export { finality } from './core/finality.js';

/**
 * Singularity Pay.
 *
 * Solana-only, and structurally so: it is built on Solana Pay's
 * transaction-request protocol, which is the one payment standard whose shape
 * already matches this project's custody boundary — the merchant builds, the
 * customer's wallet signs, and nothing in between holds a key.
 */
export {
  createIntent,
  resolveIntent,
  describeIntent,
  buildIntentPayment,
  settleIntent,
} from './pay/operations.js';
export type { CreatedIntent, SettlementResult } from './pay/operations.js';
export {
  InMemoryIntentStore,
  intentLink,
  isExpired,
  newIntentId,
  newReference,
  prepareIntent,
} from './pay/intent.js';
export type { CreateIntentParams, IntentStore, StoredIntent } from './pay/intent.js';
export { meetsSettlement, SETTLEMENT_ORDER } from './pay/types.js';
export type {
  MintRisk,
  PaymentClaim,
  PaymentSettlement,
  SettlementLevel,
} from './pay/types.js';
export { assessMintRisk, buildPayment, findPayment } from './adapters/solana.js';

/**
 * Pre-trade exit analysis: the mechanisms by which a position may not be
 * sellable. Read-only, and deliberately not a score — see `trade/types.ts`.
 */
export { inspectTokenExit } from './adapters/solana.js';
export type {
  Concentration,
  ExitMechanism,
  ExitRisk,
  TokenExitReport,
} from './trade/types.js';

/** The change-detection rule for a balance, shared by the CLI and the SDK. */
export { balanceIdentity } from './tools/operations.js';

/** Result shapes the operations return, for callers typing their own layers. */
export type {
  BalanceResult,
  BurnClaim,
  ChainSummary,
  EndpointHealthResult,
  PortfolioResult,
} from './tools/operations.js';

/**
 * The tool catalogue, for building an agent surface of your own.
 *
 * Exported with its schema converter, because the two are only useful
 * together: `shape` is a Zod shape and every framework outside MCP wants JSON
 * Schema. Handing out one without the other is how a caller ends up
 * transcribing sixteen tool definitions by hand and having them drift.
 */
export { TOOLS, TOOLS_BY_NAME, getTool } from './tools/catalog.js';
export type { ToolDefinition, ToolAnnotations } from './tools/catalog.js';
export { shapeToJsonSchema, toJsonSchema, isOptional } from './tools/json-schema.js';
export type { JsonSchema } from './tools/json-schema.js';
