#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as ops from '../tools/operations.js';
import { SingularityError } from '../core/errors.js';
import { toJson } from '../core/format.js';
import { VERSION } from '../version.js';

/**
 * Every tool returns text content holding pretty JSON.
 *
 * Errors come back as `isError` results with a code and a hint rather than
 * thrown exceptions, so the model can correct itself instead of stalling on a
 * transport error it cannot see into.
 */
type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

function ok(value: unknown): ToolResult {
  return { content: [{ type: 'text', text: toJson(value) }] };
}

function fail(err: unknown): ToolResult {
  const payload =
    err instanceof SingularityError
      ? { error: err.code, message: err.message, hint: err.hint }
      : { error: 'UNEXPECTED', message: err instanceof Error ? err.message : String(err) };

  return { content: [{ type: 'text', text: toJson(payload) }], isError: true };
}

async function run(fn: () => Promise<unknown> | unknown): Promise<ToolResult> {
  try {
    return ok(await fn());
  } catch (err) {
    return fail(err);
  }
}

const READ_ONLY = { readOnlyHint: true, openWorldHint: true } as const;

export function createServer(): McpServer {
  const server = new McpServer(
    { name: 'singularity-agent', version: VERSION },
    {
      instructions: [
        'Singularity is a read-only, multi-chain blockchain client covering EVM, Solana, Bitcoin/UTXO and Cosmos.',
        '',
        'It holds no private keys and cannot sign or broadcast. `build_transfer` returns an UNSIGNED payload for the user to sign in their own wallet — always show the summary and warnings to the user before they sign.',
        '',
        'Start with `resolve` when you are handed a bare string: it identifies whether it is an address, a transaction hash, or a name, and which chains it could belong to. `chains` lists everything supported.',
        '',
        'Balances are returned without fiat pricing. On EVM chains, token lists cover a curated set of major tokens — never present them as a complete holdings list.',
      ].join('\n'),
    },
  );

  server.registerTool(
    'chains',
    {
      title: 'List supported chains',
      description:
        'List every chain Singularity can talk to, with its family, chain id, native asset, and aliases. Use this to map a user\'s informal chain name onto a canonical id before other calls.',
      inputSchema: {
        query: z.string().optional().describe('Filter by name, id, alias, symbol, or chain id.'),
        family: z
          .enum(['evm', 'svm', 'utxo', 'cosmos'])
          .optional()
          .describe('Restrict to one chain family.'),
      },
      annotations: { ...READ_ONLY, title: 'List supported chains' },
    },
    async ({ query, family }) => run(() => ops.listChains(query, family)),
  );

  server.registerTool(
    'resolve',
    {
      title: 'Identify an address, hash, or name',
      description:
        'Work out what an arbitrary string is — an address, transaction hash, ENS/SNS name, or block height — and which chains it could belong to. Resolves names to addresses and does reverse ENS lookups. Call this first whenever the chain is not already known.',
      inputSchema: {
        input: z.string().describe('An address, transaction hash, ENS/SNS name, or block number.'),
        chain: z.string().optional().describe('Chain id or alias, when you already know it.'),
      },
      annotations: { ...READ_ONLY, title: 'Identify an address, hash, or name' },
    },
    async ({ input, chain }) => run(() => ops.resolve(input, chain)),
  );

  server.registerTool(
    'balance',
    {
      title: 'Get balances on one chain',
      description:
        'Native and token balances for one address on one chain. Accepts ENS/SNS names and address-book aliases. On EVM chains the token scan covers a curated set of major tokens unless you pass `tokens` explicitly.',
      inputSchema: {
        address: z.string().describe('Address, ENS/SNS name, or configured alias.'),
        chain: z.string().describe('Chain id or alias, e.g. "base", "solana", "btc".'),
        tokens: z
          .array(z.string())
          .optional()
          .describe('Specific token contract addresses, mints, or denoms to check.'),
        includeTokens: z
          .boolean()
          .optional()
          .describe('Set false to fetch only the native balance (faster).'),
      },
      annotations: { ...READ_ONLY, title: 'Get balances on one chain' },
    },
    async (args) => run(() => ops.getBalance(args)),
  );

  server.registerTool(
    'portfolio',
    {
      title: 'Get balances across many chains',
      description:
        'Query one address across many chains in parallel. Chains where the address format does not apply are skipped rather than reported as errors. Returns balances only — there is no fiat pricing.',
      inputSchema: {
        address: z.string().describe('Address, ENS/SNS name, or configured alias.'),
        chains: z
          .array(z.string())
          .optional()
          .describe('Chains to query. Defaults to a spread of major chains across all four families.'),
        includeTokens: z.boolean().optional().describe('Set false for native balances only.'),
      },
      annotations: { ...READ_ONLY, title: 'Get balances across many chains' },
    },
    async (args) => run(() => ops.getPortfolio(args)),
  );

  server.registerTool(
    'transaction',
    {
      title: 'Look up a transaction',
      description:
        'Fetch and normalize a transaction, with EVM calldata decoded where the selector is recognized. If no chain is given, searches the chains the hash format allows and reports every chain it was found on.',
      inputSchema: {
        hash: z.string().describe('Transaction hash, txid, or Solana signature.'),
        chain: z.string().optional().describe('Chain id, to skip the cross-chain search.'),
      },
      annotations: { ...READ_ONLY, title: 'Look up a transaction' },
    },
    async (args) => run(() => ops.getTransaction(args)),
  );

  server.registerTool(
    'block',
    {
      title: 'Get a block',
      description:
        'Fetch a block by height, hash, or "latest". On Solana this addresses a slot; on Cosmos, a block height.',
      inputSchema: {
        chain: z.string().describe('Chain id or alias.'),
        ref: z
          .union([z.string(), z.number()])
          .optional()
          .describe('Block height, hash, or "latest" (default).'),
      },
      annotations: { ...READ_ONLY, title: 'Get a block' },
    },
    async (args) => run(() => ops.getBlock(args)),
  );

  server.registerTool(
    'fees',
    {
      title: 'Estimate current fees',
      description:
        'Current fee conditions on a chain, normalized to "what a simple transfer costs right now" plus the chain-specific knobs (gwei, sat/vB, lamports, gas price).',
      inputSchema: { chain: z.string().describe('Chain id or alias.') },
      annotations: { ...READ_ONLY, title: 'Estimate current fees' },
    },
    async ({ chain }) => run(() => ops.getFees(chain)),
  );

  server.registerTool(
    'read_contract',
    {
      title: 'Read contract or account state',
      description:
        'Call a view function on an EVM contract (supply `abi` in human-readable form plus `method`), or read parsed account data on Solana. Never sends a transaction.',
      inputSchema: {
        chain: z.string().describe('Chain id or alias.'),
        address: z.string().describe('Contract address (EVM) or account address (Solana).'),
        method: z.string().optional().describe('EVM function name, e.g. "balanceOf".'),
        abi: z
          .string()
          .optional()
          .describe('Human-readable ABI entry, e.g. "function balanceOf(address) view returns (uint256)".'),
        args: z.array(z.unknown()).optional().describe('Arguments for the call, in order.'),
      },
      annotations: { ...READ_ONLY, title: 'Read contract or account state' },
    },
    async (args) => run(() => ops.readContract(args)),
  );

  server.registerTool(
    'decode',
    {
      title: 'Decode EVM calldata',
      description:
        'Decode a hex calldata blob into a function signature and arguments. Recognizes common ERC-20/721/1155, WETH, and router calls out of the box; pass `abi` for anything else.',
      inputSchema: {
        data: z.string().describe('Hex calldata, with or without the 0x prefix.'),
        abi: z
          .array(z.string())
          .optional()
          .describe('Human-readable ABI entries to decode against, e.g. ["function foo(uint256 bar)"].'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false, title: 'Decode EVM calldata' },
    },
    async ({ data, abi }) => run(() => ops.decode(data, abi)),
  );

  server.registerTool(
    'build_transfer',
    {
      title: 'Build an unsigned transfer',
      description:
        'Build an UNSIGNED transfer for the user to sign in their own wallet. Singularity holds no keys and never signs or broadcasts. Always show the returned `summary` and `warnings` to the user before they sign anything.',
      inputSchema: {
        chain: z.string().describe('Chain id or alias.'),
        to: z.string().describe('Recipient address, name, or alias.'),
        amount: z.string().describe('Human decimal amount, e.g. "1.5". Never base units.'),
        from: z
          .string()
          .optional()
          .describe('Sender. Required on Solana, Bitcoin, and Cosmos; optional on EVM.'),
        token: z
          .string()
          .optional()
          .describe('Token contract, mint, denom, or known symbol. Omit for the native asset.'),
        memo: z.string().optional().describe('Memo, on chains that support one (Cosmos).'),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
        title: 'Build an unsigned transfer',
      },
    },
    async (args) => run(() => ops.buildTransfer(args)),
  );

  return server;
}

async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout is the MCP transport — anything written there corrupts the protocol.
  process.stderr.write(`singularity-agent MCP server ${VERSION} ready on stdio\n`);
}

// Only auto-start when executed directly, so tests can import createServer().
// Comparing real paths rather than URLs keeps this correct on Windows, where
// drive letters and symlinks make naive file:// comparison unreliable.
const invokedDirectly = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(entry);
  } catch {
    return false;
  }
})();

if (invokedDirectly || process.env.SINGULARITY_MCP_AUTOSTART === '1') {
  main().catch((err) => {
    process.stderr.write(`singularity-agent failed to start: ${(err as Error).message}\n`);
    process.exit(1);
  });
}
