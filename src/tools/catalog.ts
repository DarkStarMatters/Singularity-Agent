/**
 * The tool catalogue — one definition per capability, consumed by every model
 * front end.
 *
 * Before this existed the MCP server held the only copy of the tool names,
 * descriptions and argument schemas. Adding Grok function calling would have
 * meant a second copy, and the two would have drifted the first time a
 * description was improved in one place. So the definitions live here and the
 * MCP server registers from them; `src/grok/tools.ts` converts the same
 * definitions into function-calling schemas.
 *
 * Descriptions are written for a model deciding *whether* to call, not for a
 * human reading docs — they say when to reach for the tool and what it will not
 * do, because that is what stops a wrong call.
 */
import { z } from 'zod';
import * as ops from './operations.js';

export interface ToolAnnotations {
  readOnlyHint: boolean;
  openWorldHint: boolean;
  destructiveHint?: boolean;
}

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  /** Zod shape — the source for both MCP registration and JSON Schema. */
  shape: z.ZodRawShape;
  annotations: ToolAnnotations;
  run(args: Record<string, unknown>): Promise<unknown> | unknown;
}

/** Everything here reads public chain state and cannot change it. */
const READ_ONLY: ToolAnnotations = { readOnlyHint: true, openWorldHint: true };

/**
 * Keeps each `run` typed against its own shape while erasing the generic in the
 * exported list, so the catalogue can be iterated without a union type.
 */
function defineTool<S extends z.ZodRawShape>(spec: {
  name: string;
  title: string;
  description: string;
  shape: S;
  annotations?: ToolAnnotations;
  run(args: z.infer<z.ZodObject<S>>): Promise<unknown> | unknown;
}): ToolDefinition {
  return {
    name: spec.name,
    title: spec.title,
    description: spec.description,
    shape: spec.shape,
    annotations: spec.annotations ?? READ_ONLY,
    run: (args) => spec.run(args as z.infer<z.ZodObject<S>>),
  };
}

export const TOOLS: ToolDefinition[] = [
  defineTool({
    name: 'chains',
    title: 'List supported chains',
    description:
      "List every chain Singularity can talk to, with its family, chain id, native asset, and aliases. Use this to map a user's informal chain name onto a canonical id before other calls.",
    shape: {
      query: z.string().optional().describe('Filter by name, id, alias, symbol, or chain id.'),
      family: z
        .enum(['evm', 'svm', 'utxo', 'cosmos'])
        .optional()
        .describe('Restrict to one chain family.'),
    },
    run: ({ query, family }) => ops.listChains(query, family),
  }),

  defineTool({
    name: 'resolve',
    title: 'Identify an address, hash, or name',
    description:
      'Work out what an arbitrary string is — an address, transaction hash, ENS/SNS name, or block height — and which chains it could belong to. Resolves names to addresses and does reverse ENS lookups. Call this first whenever the chain is not already known.',
    shape: {
      input: z.string().describe('An address, transaction hash, ENS/SNS name, or block number.'),
      chain: z.string().optional().describe('Chain id or alias, when you already know it.'),
    },
    run: ({ input, chain }) => ops.resolve(input, chain),
  }),

  defineTool({
    name: 'balance',
    title: 'Get balances on one chain',
    description:
      'Native and token balances for one address on one chain. Accepts ENS/SNS names and address-book aliases. On EVM chains the token scan covers a curated set of major tokens unless you pass `tokens` explicitly.',
    shape: {
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
    run: (args) => ops.getBalance(args),
  }),

  defineTool({
    name: 'portfolio',
    title: 'Get balances across many chains',
    description:
      'Query one address across many chains in parallel. Chains where the address format does not apply are skipped rather than reported as errors. Returns balances only — there is no fiat pricing.',
    shape: {
      address: z.string().describe('Address, ENS/SNS name, or configured alias.'),
      chains: z
        .array(z.string())
        .optional()
        .describe('Chains to query. Defaults to a spread of major chains across all four families.'),
      includeTokens: z.boolean().optional().describe('Set false for native balances only.'),
    },
    run: (args) => ops.getPortfolio(args),
  }),

  defineTool({
    name: 'transaction',
    title: 'Look up a transaction',
    description:
      'Fetch and normalize a transaction, with EVM calldata decoded where the selector is recognized. If no chain is given, searches the chains the hash format allows and reports every chain it was found on.',
    shape: {
      hash: z.string().describe('Transaction hash, txid, or Solana signature.'),
      chain: z.string().optional().describe('Chain id, to skip the cross-chain search.'),
    },
    run: (args) => ops.getTransaction(args),
  }),

  defineTool({
    name: 'block',
    title: 'Get a block',
    description:
      'Fetch a block by height, hash, or "latest". On Solana this addresses a slot; on Cosmos, a block height.',
    shape: {
      chain: z.string().describe('Chain id or alias.'),
      ref: z
        .union([z.string(), z.number()])
        .optional()
        .describe('Block height, hash, or "latest" (default).'),
    },
    run: (args) => ops.getBlock(args),
  }),

  defineTool({
    name: 'fees',
    title: 'Estimate current fees',
    description:
      'Current fee conditions on a chain, normalized to "what a simple transfer costs right now" plus the chain-specific knobs (gwei, sat/vB, lamports, gas price).',
    shape: { chain: z.string().describe('Chain id or alias.') },
    run: ({ chain }) => ops.getFees(chain),
  }),

  defineTool({
    name: 'read_contract',
    title: 'Read contract or account state',
    description:
      'Call a view function on an EVM contract (supply `abi` in human-readable form plus `method`), or read parsed account data on Solana. Never sends a transaction.',
    shape: {
      chain: z.string().describe('Chain id or alias.'),
      address: z.string().describe('Contract address (EVM) or account address (Solana).'),
      method: z.string().optional().describe('EVM function name, e.g. "balanceOf".'),
      abi: z
        .string()
        .optional()
        .describe(
          'Human-readable ABI entry, e.g. "function balanceOf(address) view returns (uint256)".',
        ),
      args: z.array(z.unknown()).optional().describe('Arguments for the call, in order.'),
    },
    run: (args) => ops.readContract(args),
  }),

  defineTool({
    name: 'decode',
    title: 'Decode EVM calldata',
    description:
      'Decode a hex calldata blob into a function signature and arguments. Recognizes common ERC-20/721/1155, WETH, and router calls out of the box; pass `abi` for anything else.',
    shape: {
      data: z.string().describe('Hex calldata, with or without the 0x prefix.'),
      abi: z
        .array(z.string())
        .optional()
        .describe(
          'Human-readable ABI entries to decode against, e.g. ["function foo(uint256 bar)"].',
        ),
    },
    // Pure computation: nothing outside the process is consulted.
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: ({ data, abi }) => ops.decode(data, abi),
  }),

  defineTool({
    name: 'build_transfer',
    title: 'Build an unsigned transfer',
    description:
      'Build an UNSIGNED transfer for the user to sign in their own wallet. Singularity holds no keys and never signs or broadcasts. Always show the returned `summary` and `warnings` to the user before they sign anything.',
    shape: {
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
    annotations: { readOnlyHint: true, openWorldHint: true, destructiveHint: false },
    run: (args) => ops.buildTransfer(args),
  }),
];

export const TOOLS_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

export function getTool(name: string): ToolDefinition | undefined {
  return TOOLS_BY_NAME.get(name);
}
