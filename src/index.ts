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
