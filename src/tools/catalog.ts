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
      'Native and token balances for one address on one chain. Accepts ENS/SNS names and address-book aliases. On EVM chains the token scan covers a curated set of major tokens unless you pass `tokens` explicitly. Pass `atBlock` to read a past block instead of now.',
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
      atBlock: z
        .union([z.string(), z.number()])
        .optional()
        .describe(
          'Read state as of this block height instead of now. Supported on EVM (needs an archive endpoint) and Cosmos (needs an archive LCD). Solana and UTXO chains reject it outright rather than answering with current state, so a result carrying `atBlock` is always genuinely historical.',
        ),
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
      'Call a view function on an EVM contract (supply `abi` in human-readable form plus `method`), or read parsed account data on Solana. Pass `atBlock` to call against a past block. Never sends a transaction.',
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
      atBlock: z
        .union([z.string(), z.number()])
        .optional()
        .describe(
          'Read state as of this block height instead of now. Supported on EVM (needs an archive endpoint) and Cosmos (needs an archive LCD). Solana and UTXO chains reject it outright rather than answering with current state, so a result carrying `atBlock` is always genuinely historical.',
        ),
    },
    run: (args) => ops.readContract(args),
  }),

  defineTool({
    name: 'mint_audit',
    title: 'Audit a Solana mint',
    description:
      'What a Solana mint account permits, read from the mint itself: which token program owns it, whether more can be minted, whether holder accounts can be frozen, whether its name can still be rewritten, and every Token-2022 extension on it — permanent delegate, transfer hook, transfer fee, default-frozen accounts, non-transferable, interest-bearing. Reach for it whenever someone asks whether a token is safe, what a mint can do to them, or why a transfer failed, and before treating an unfamiliar mint as ordinary. It returns powers and the addresses holding them, plus what is permanently settled — never a score or a verdict, because liquidity, holder concentration and the deployer are not in these bytes. Solana only. The metadata link is reported and deliberately never fetched.',
    shape: {
      mint: z.string().describe('The mint address.'),
      chain: z
        .string()
        .optional()
        .describe('Solana chain id or alias. Defaults to "solana"; a non-Solana chain is refused.'),
    },
    run: (args) => ops.auditMint(args),
  }),

  defineTool({
    name: 'decode',
    title: 'Decode EVM calldata',
    description:
      'Decode a hex calldata blob into a function signature and arguments. Recognizes common ERC-20/721/1155, WETH, Multicall3 and Safe calls out of the box, and unwraps batches — a multicall, an aggregate, an execTransaction or a multiSend reports the calls it carries under `inner`. Pass `abi` for anything else, or set `lookup` to ask a public 4-byte directory for candidate signatures when the selector is unknown (those are third-party guesses, marked untrusted, and never promoted to `signature`).',
    shape: {
      data: z.string().describe('Hex calldata, with or without the 0x prefix.'),
      abi: z
        .array(z.string())
        .optional()
        .describe(
          'Human-readable ABI entries to decode against, e.g. ["function foo(uint256 bar)"].',
        ),
      lookup: z
        .boolean()
        .optional()
        .describe(
          'When the selector is not recognized, ask a public 4-byte directory for candidate signatures. Off by default: it discloses the selector to a third party, and anyone may submit an entry there, so results come back as untrusted candidates rather than as an identification.',
        ),
    },
    // `openWorldHint` is true because of `lookup`, and only because of it.
    // Every other path here is pure computation, but a hint that is accurate
    // for the default and wrong for the flag is worse than one that is simply
    // conservative — the caller uses it to decide what this tool may reach.
    annotations: { readOnlyHint: true, openWorldHint: true },
    run: ({ data, abi, lookup }) => ops.decode(data, abi, lookup),
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

  defineTool({
    name: 'build_burn',
    title: 'Build an unsigned burn',
    description:
      'Build an UNSIGNED burn of a Solana token for the holder to sign in their own wallet. Singularity holds no keys and never signs or broadcasts. A burn destroys the tokens permanently: nobody receives them and nobody can return them, so always show the returned `summary` and every `warning` before the user signs. Refuses rather than building something that cannot land — no token account, a frozen account, or a balance below the amount. Warns when the mint authority is still live, because a burn against a mint that can print more reduces a balance without reducing supply. Solana only.',
    shape: {
      mint: z.string().describe('Mint address, or an address-book alias for one.'),
      amount: z
        .string()
        .describe('Human decimal amount to destroy, e.g. "1000". Never base units.'),
      owner: z.string().describe('The wallet holding the tokens. It signs, and pays the fee.'),
      chain: z
        .string()
        .optional()
        .describe('Solana chain id or alias. Defaults to "solana"; a non-Solana chain is refused.'),
    },
    // Building is a read: it returns bytes and changes nothing. What the user
    // then signs is destructive, and that is said in the description, the
    // summary and the warnings rather than by mislabelling this call.
    annotations: { readOnlyHint: true, openWorldHint: true, destructiveHint: false },
    run: (args) => ops.buildBurn(args),
  }),

  defineTool({
    name: 'verify_burn',
    title: 'Confirm a burn from its signature',
    description:
      'Confirm that a Solana transaction really burned a token: which mint, which owner, how much, at finalized commitment. Pass `mint` (and optionally `owner` and a `minimum` amount) to check the burn against a claim rather than just describing it — a transaction that burned a different mint is refused by name. Reports whether the signature has already been redeemed, and never spends it. A signature is public the moment it lands, so this proves a burn happened and proves nothing about who quoted it; what binds a burn to a claimant is the memo the burner signed into it, which is returned when there is one.',
    shape: {
      signature: z.string().describe('The transaction signature of the burn.'),
      mint: z
        .string()
        .optional()
        .describe('The mint the burn must be of. Matched by address, never by symbol.'),
      owner: z.string().optional().describe('The wallet that must have signed the burn.'),
      minimum: z
        .string()
        .optional()
        .describe('The least that must have been destroyed, as a human decimal amount, e.g. "1000".'),
      chain: z.string().optional().describe('Solana chain id or alias. Defaults to "solana".'),
    },
    run: (args) => ops.verifyBurn(args),
  }),
];

export const TOOLS_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

export function getTool(name: string): ToolDefinition | undefined {
  return TOOLS_BY_NAME.get(name);
}
