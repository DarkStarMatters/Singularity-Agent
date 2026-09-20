/**
 * singularity-sdk — build blockchain applications on Singularity Agent.
 *
 * The agent is a read-only client and an MCP plugin: one normalized surface
 * over EVM, Solana, Bitcoin and Cosmos, for a human at a terminal or a model
 * over MCP. This SDK is the third caller — an application — and it adds the
 * four things an application needs that a CLI does not:
 *
 * 1. **A configured client.** Defaults set once instead of on every call, a
 *    cache that only holds what is safe to hold, and retry on the failures
 *    worth another attempt. `client.ts`.
 * 2. **A custody seam.** A `Signer` port the application implements, so an app
 *    can complete a write without this package ever holding a key. The SDK
 *    ships no implementation, and `write` does not exist as a type until you
 *    supply one. `signer.ts`.
 * 3. **Watching.** Polling loops with backoff, change detection and honest
 *    documentation of what a poll cannot see. `watch.ts`.
 * 4. **An agent surface.** The same tool catalogue the MCP plugin serves,
 *    derived into Anthropic, OpenAI-style and MCP shapes, with a policy hook
 *    in front. An app built on this SDK is an agent the plugin can drive, and
 *    the reverse. `tools.ts`.
 *
 * The one thing it does not add is a way to sign. That is on purpose, and
 * `signer.ts` explains why at length.
 */

export { createSingularity, assertWritable } from './client.js';
export type { Singularity, WriteApi, BuildApi, WriteReceipt } from './client.js';

export type { SingularityConfig, ResolvedConfig } from './config.js';

export { isSigner, SIGNER_REQUIRED } from './signer.js';
export type { Signer, SignedTx, SignerRequired } from './signer.js';

export { createWatch } from './watch.js';
export type { Change, Handler, Subscription, WatchApi, WatchOptions } from './watch.js';

export {
  TOOLS,
  getTool,
  selectTools,
  anthropicTools,
  functionTools,
  mcpTools,
  runTool,
  createExecutor,
} from './tools.js';
export type {
  AnthropicTool,
  Executor,
  FunctionTool,
  McpTool,
  ToolDefinition,
  ToolResult,
  ToolSelection,
} from './tools.js';

export { createPay } from './pay.js';
export type {
  CreateIntentParams,
  CreatedIntent,
  IntentStore,
  PayApi,
  PayConfig,
  PayResponse,
  ReceiptBundle,
  RenderedLink,
  SettlementLevel,
  SettlementResult,
  StoredIntent,
} from './pay.js';

export { ReadCache, DEFAULT_TTL, DEFAULT_RETRY, cacheKey, isTransient, withRetry } from './cache.js';
export type { CacheClass, CacheStats, CacheTtl, RetryPolicy } from './cache.js';

export { SdkError, isSdkError } from './errors.js';
export type { SdkErrorCode } from './errors.js';

export { SDK_VERSION } from './version.js';

/**
 * Everything the agent core exposes, for the cases this SDK has not wrapped.
 *
 * Re-exported rather than left as a peer import so an application has one
 * dependency and one import site. `operations` in particular is the unwrapped
 * surface — no client defaults, no cache — and is the right thing to reach for
 * when you want exactly what the CLI does.
 */
export {
  allChains,
  getChain,
  chainsByFamily,
  detect,
  formatUnits,
  parseUnits,
  amount,
  explorerUrl,
  decodeCalldata,
  decodeWithAbi,
  adapterFor,
  adapterForFamily,
  completeness,
  InMemoryIntentStore,
  meetsSettlement,
  qrMatrix,
  qrUnicode,
  qrSvg,
  qrPng,
  qrDataUrl,
  renderQrArt,
  qrArtPng,
  qrArtDataUrl,
  styleFor,
  paletteFor,
  contrastRatio,
  SeedStream,
  receiptFacts,
  receiptImage,
  receiptMetadata,
  verifyReceiptImage,
  uriFits,
  buildReceiptMint,
  metadataAddress,
  masterEditionAddress,
  associatedTokenAddress,
  assessMintRisk,
  operations,
  shapeToJsonSchema,
  VERSION as AGENT_VERSION,
} from 'singularity-agent';

/**
 * The artwork and receipt types, re-exported so an application has one import.
 *
 * Every QR this SDK renders is artwork seeded by the payment's reference, and
 * every settled payment can become a receipt NFT of that same picture. The
 * agent renders identically from the same seed, which is the point: a customer
 * comparing the code in a Telegram message against the one in a checkout page
 * sees the same thing, and neither side had to be told the style.
 */
export type {
  ArtStyle,
  ArtOptions,
  ModuleShape,
  FinderStyle,
  Palette,
  RasterOptions,
  ReceiptFacts,
  ReceiptMetadataOptions,
  ReceiptMint,
  ReceiptMintParams,
} from 'singularity-agent';

export * from './types.js';
