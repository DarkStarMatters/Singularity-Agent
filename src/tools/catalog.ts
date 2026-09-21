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
import { parseBudget } from '../core/budget.js';

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

/**
 * How much of a list the caller has room for.
 *
 * Offered on every tool that returns one. The named sizes exist because a model
 * knows its own context far better than it knows how many SPL mints a wallet
 * holds, so "I have room for a little" is a question it can actually answer;
 * `maxItems` is there for a caller that has done the arithmetic.
 *
 * Shaping never hides a cut. A list shortened to fit comes back with
 * `completeness.kind === 'truncated'` and both counts, and the note says the
 * budget did it rather than the chain — so a caller can tell the difference
 * between "there is no more" and "ask again for more".
 */
const budgetArg = z
  .union([z.enum(['small', 'standard', 'full']), z.number().int().positive()])
  .optional()
  .describe(
    "How much of each list to return: 'small' (10 items, for a tight context), 'standard' (the default), 'full' (this source's maximum), or a number for an exact count. Omitting it changes nothing. Anything cut is reported in `completeness` as truncated with counts, never dropped silently.",
  );

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
      budget: budgetArg,
    },
    run: (args) => ops.getBalance({ ...args, budget: parseBudget(args.budget) }),
  }),

  defineTool({
    name: 'portfolio',
    title: 'Get balances for a set of addresses across many chains',
    description:
      "Query one address, or a whole set of them, across many chains in parallel. Pass `addresses` when somebody holds an EVM address, a Solana pubkey and a Bitcoin address — that is one person's holdings and would otherwise be three separate questions. Each address is matched only to the chains its own format is valid on, so this is not a cross product and a Solana pubkey never produces twenty EVM errors; an address valid nowhere is reported in `errors` rather than failing the call. `holdings` is the consolidated view, by asset rather than by chain. It sums only where a sum is honest: the same token, on the same chain, across the addresses you gave. It never adds a token to itself across chains — USDC on Ethereum and USDC on Base are different contracts with different issuers of record — and never merges two contracts because they share a ticker, since only symbols this tool supplies itself are grouped by name at all. `spansChains` marks an asset found in more than one place. Read `completeness` before concluding anything is absent. Balances only: there is no fiat pricing and therefore no total value.",
    shape: {
      address: z
        .string()
        .optional()
        .describe('One address, ENS/SNS name, or configured alias. Use `addresses` for a set.'),
      addresses: z
        .array(z.string())
        .optional()
        .describe('Several addresses, which may span chain families. Deduplicated before querying.'),
      chains: z
        .array(z.string())
        .optional()
        .describe('Chains to query. Defaults to a spread of major chains across all four families.'),
      includeTokens: z.boolean().optional().describe('Set false for native balances only.'),
      budget: budgetArg,
    },
    run: (args) => ops.getPortfolio({ ...args, budget: parseBudget(args.budget) }),
  }),

  defineTool({
    name: 'transaction',
    title: 'Look up a transaction',
    description:
      'Fetch and normalize a transaction, with EVM calldata decoded where the selector is recognized. If no chain is given, searches the chains the hash format allows and reports every chain it was found on. Read `finality` alongside `status`, because they answer different questions: `status` says the chain executed the transaction and it did not revert, while `finality` says whether the block holding it can still be discarded. `final` is the only kind that licenses an irreversible decision. `reversible` means it sits at or near the head and a reorganization would erase it. `probabilistic` is proof-of-work settlement — it carries a confirmation count and never becomes `final` at any depth, because the chain offers no point past which reversal is disallowed, only one past which it is expensive; how many confirmations are enough is the caller’s decision. `unknown` means the endpoint would not say, which is not evidence that it is settled.',
    shape: {
      hash: z.string().describe('Transaction hash, txid, or Solana signature.'),
      chain: z.string().optional().describe('Chain id, to skip the cross-chain search.'),
    },
    run: (args) => ops.getTransaction(args),
  }),

  defineTool({
    name: 'history',
    title: "What an address has been doing",
    description:
      'Recent transactions for an address on one chain, newest first. Read `completeness` before the entries: an empty list can mean no activity, an unconfigured indexer, or a family that cannot answer, and those are different answers. Solana, Bitcoin and Cosmos answer from their own endpoints; EVM history needs SINGULARITY_ETHERSCAN_KEY and says so when it is missing rather than returning nothing.',
    shape: {
      address: z.string().describe('Address to look up.'),
      chain: z.string().describe('Chain id or alias. History is single-chain.'),
      limit: z
        .number()
        .optional()
        .describe(
          'Exact entries to return. Where `budget` is also given the smaller of the two wins, so neither can talk the other into a bigger response.',
        ),
      budget: budgetArg,
      cursor: z
        .string()
        .optional()
        .describe('Continuation token from a previous call. Opaque — pass it back unchanged.'),
    },
    run: (args) => ops.getHistory({ ...args, budget: parseBudget(args.budget) }),
  }),

  defineTool({
    name: 'block',
    title: 'Get a block',
    description:
      'Fetch a block by height, hash, or "latest". On Solana this addresses a slot; on Cosmos, a block height. The `finality` field says whether the block can still be reorganized away: `final` is settled under the chain’s own consensus rules, `reversible` is not, `probabilistic` is proof-of-work depth and never reaches `final`, and `unknown` means the endpoint declined to say rather than that the block is settled.',
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
      memo: z
        .string()
        .optional()
        .describe(
          'Text written into the transaction as an SPL memo, signed along with everything else. This is what lets the burn be credited to a particular claimant later: a signature is public the moment it lands, so without a memo the first party to quote it takes the credit. Public and permanent.',
        ),
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
      expectMemo: z
        .string()
        .optional()
        .describe(
          "Text the burn's memo must contain. The memo is the only part of the transaction the burner wrote and signed, so it is what makes a burn attributable to a claimant rather than to whoever quotes the signature first.",
        ),
      chain: z.string().optional().describe('Solana chain id or alias. Defaults to "solana".'),
    },
    run: (args) => ops.verifyBurn(args),
  }),

  defineTool({
    name: 'token_identity',
    title: 'What a mint declares, and whether it can change',
    description:
      'Read what a Solana mint says it is — its name, ticker, metadata link — and, crucially, whether any of that can be rewritten later at the same address. Where the update authority is revoked and the link is content-addressed (an IPFS CID), what the mint declares is fixed at mint time and cannot be swapped. Set `fetch` to also read the document and return the accounts it declares (X, Telegram, website, GitHub); it is off by default because the link is a URL chosen by whoever deployed the mint. Use it to answer whether a token, or an account claiming to represent one, is the real one — the answer is always the mint address, never the ticker. A mint wearing a curated token\u2019s symbol or name at a different address is reported as impersonation.',
    shape: {
      mint: z.string().describe('Mint address, or an address-book alias for one.'),
      fetch: z
        .boolean()
        .optional()
        .describe('Also fetch the metadata document and read the accounts it declares. Off by default: it is an outbound request to a URL the deployer chose.'),
      chain: z.string().optional().describe('Solana chain id or alias. Defaults to "solana".'),
    },
    run: (args) => ops.tokenIdentity(args),
  }),

  defineTool({
    name: 'chain_liveness',
    title: 'Whether a chain is serving current state',
    description:
      'Check that a chain is actually producing blocks, rather than merely answering. A chain that has halted still responds to every request, with the correct chain id, serving the last block it ever made — so a balance read from it is historical state carrying no indication that it is historical. Each configured endpoint is probed separately, so this also reports endpoints that answer but lag behind the others, and chains left with no working failover. Call it when a read looks implausible, when an answer must be current to be worth acting on, or before treating an absence as fact. `status` is one of: `live`; `stale` (the head is old enough that nothing here is current); `lagging` (endpoints disagree enough that which one answers changes the result); `single` (only one endpoint answered, so the next failure is total); `undatable` (answering, but nothing will say when the head was produced); `skewed` (the head is dated in the future, so its age proves nothing); `down`. Only `live` means the chain can be read with confidence, and `stale` in particular does not surface as an error anywhere else.',
    shape: {
      chain: z
        .array(z.string())
        .optional()
        .describe('Chain ids or aliases to check. Defaults to every configured chain.'),
    },
    run: ({ chain }) => ops.checkLiveness(chain),
  }),

  defineTool({
    name: 'inspect_exit',
    title: 'Whether a token can be sold again',
    description:
      'Before buying a Solana token, find out what could stop you selling it. Names the specific mechanisms rather than scoring the token: a transfer hook (issuer code runs on every transfer, including your sale, and can refuse it), a permanent delegate (an address can move the token out of your wallet without you signing), a live freeze authority (your token account can be frozen, leaving a balance you own and cannot sell), a default-frozen account state, a non-transferable mint, transfer fees, and supply concentrated in one non-pool account. Each entry says who holds the power. `canExit` is false when at least one mechanism can block a sale or seize the balance. **`canExit: true` does not mean safe to buy** — this reads the mint account and the largest holders, not the market, so it says nothing about whether liquidity is locked, how deep the pool is, or what the token is worth. Read `completeness`, which always says what was not covered. This is a read: it builds nothing, signs nothing, and routes no trade.',
    shape: {
      mint: z.string().describe('Mint address, or an address-book alias for one.'),
      chain: z.string().optional().describe('Solana chain id or alias. Defaults to "solana".'),
    },
    run: (args) => ops.inspectExit(args),
  }),
  defineTool({
    name: 'inspect_payment',
    title: 'Whether a payment you were asked to make can actually be paid',
    description:
      "Before signing a payment somebody else asked you to make, find out whether it can be paid at all. Takes an invoice or payment intent in the shape it arrived — payee, token, claimed ticker, amount, base units, decimals, expiry — and checks each claim against the chain instead of against the rest of the invoice. Works on Solana and on EVM chains, reading each family's own failure modes. Everywhere: a token address that is well-formed with no token at it, a displayed amount and a base-unit amount that disagree, decimals that do not match the token, a ticker naming one token while the address names another, and an expiry already passed. On Solana it also reads the destination token account — whether it exists, holds that mint, is frozen, or belongs to somebody other than the payee named — and whether the mint charges a transfer fee, which makes the payee receive less than you send. On EVM it reads whether the payee is the zero address, the token's own contract (one of the most common ways ERC-20s are permanently lost), or a contract that may be unable to move the token out again. Reach for it whenever a payment demand arrives from anywhere you do not control — an exchange, an API, a marketplace, another agent — and before building or signing anything against it. `verdict` is `unpayable` when at least one finding means signing cannot do what the demand says, `payable` when every stated claim checked out, and `unproven` when the chain could not be read, which is not the same as cleared. Read `findings` before `verdict`. This reads: it builds nothing, signs nothing and sends nothing, and `unpayable` means the demand is wrong rather than that the counterparty is dishonest — a typo in somebody else's configuration produces exactly this.",
    shape: {
      to: z.string().optional().describe('The wallet the demand says will be paid.'),
      tokenAccount: z
        .string()
        .optional()
        .describe('The exact destination token account the demand names, where it names one.'),
      mint: z
        .string()
        .optional()
        .describe('Token address — the mint on Solana. Omit for the native asset. Never a ticker.'),
      token: z
        .string()
        .optional()
        .describe('Alias for `mint`, for EVM chains where the token is a contract rather than a mint.'),
      asset: z
        .string()
        .optional()
        .describe('The ticker the demand claims, e.g. USDC. Checked against `mint`, never used instead of it.'),
      amount: z.string().optional().describe('Whole tokens as a decimal string, as the demand displays it.'),
      amountBaseUnits: z
        .string()
        .optional()
        .describe('The same amount in base units, where the demand states both. They must agree.'),
      decimals: z.number().optional().describe('The decimals the demand assumes. Checked against the mint.'),
      memo: z.string().optional().describe('Text the demand says the payment must carry.'),
      reference: z.string().optional().describe('The Solana Pay reference that would make the payment findable.'),
      expiresAt: z.string().optional().describe('When the demand stops being valid, ISO 8601.'),
      chain: z.string().optional().describe('Chain id or alias, EVM or Solana. Defaults to "solana".'),
    },
    run: (args) => ops.inspectPayment(args),
  }),
  defineTool({
    name: 'build_payment',
    title: 'Check a demand, then build the payment if it survives',
    description:
      "Check a payment demand and build the UNSIGNED transaction for it, refusing to build at all when the demand does not check out. Same checks as `inspect_payment` — reach for that one when you only want the verdict, and this one when the payment is actually going to be made. The difference is that here `unpayable` is a refusal rather than advice: nothing is returned to sign. `unproven` refuses too, because a demand that could not be checked is not a demand that passed. On Solana the demand's `reference` is attached to the transfer as a read-only account, which is what lets the payee match the payment to the order without trusting the payer to quote anything. Warnings found during checking are carried into the transaction's own `warnings`, since that is the last text read before a signature. Singularity holds no keys: this returns an unsigned payload and the report that justified building it, and signing happens in the user's own wallet. Always show the summary, every warning and the verdict before they sign.",
    shape: {
      from: z.string().describe('The wallet that will pay, and sign. Required — the transaction is built for it.'),
      to: z.string().optional().describe('The wallet the demand says will be paid.'),
      tokenAccount: z
        .string()
        .optional()
        .describe('The exact destination token account the demand names, where it names one.'),
      mint: z.string().optional().describe('Token address — the mint on Solana. Omit for the native asset.'),
      token: z.string().optional().describe('Alias for `mint`, for EVM chains where the token is a contract.'),
      asset: z.string().optional().describe('The ticker the demand claims. Checked against the token address.'),
      amount: z.string().optional().describe('Whole tokens as a decimal string, as the demand displays it.'),
      amountBaseUnits: z.string().optional().describe('The same amount in base units, where the demand states both.'),
      decimals: z.number().optional().describe('The decimals the demand assumes.'),
      memo: z.string().optional().describe('Text the demand says the payment must carry.'),
      reference: z.string().optional().describe('The Solana Pay reference that makes the payment findable.'),
      expiresAt: z.string().optional().describe('When the demand stops being valid, ISO 8601.'),
      chain: z.string().optional().describe('Chain id or alias, EVM or Solana. Defaults to "solana".'),
    },
    run: (args) => ops.payDemand(args),
  }),
  defineTool({
    name: 'receipt_art',
    title: 'What a payment receipt looks like, and whether an image is it',
    description:
      "Every Singularity payment QR is artwork derived from the payment's `reference` — the pubkey attached to the transfer that makes it findable on chain. Because it is derived rather than stored, the picture is a fingerprint of one payment: two payments can never render alike, and anyone holding the reference can re-derive it. Pass a `reference` (or a receipt `uri` of the form <base>/<reference>.json, which is how the reference reaches the chain) to get the style traits a marketplace would list. Pass `link` as well to render the code. Pass `image` to ask the question that matters: **is this picture the one this reference generates?** A receipt NFT's metadata is served by a host that can change it, and this is how a holder checks the image they are being shown is evidence of their payment rather than something swapped in. `matches: false` is not proof of fraud — it means the image is not evidence. This is pure: it reads no chain, fetches nothing, and signs nothing.",
    shape: {
      reference: z
        .string()
        .optional()
        .describe('The payment reference the art is derived from.'),
      uri: z
        .string()
        .optional()
        .describe('A receipt metadata uri to read the reference out of, when you do not have it directly.'),
      link: z
        .string()
        .optional()
        .describe('The solana: payment link, needed to render or compare a picture.'),
      image: z
        .string()
        .optional()
        .describe('An SVG to check against what the reference generates. Requires `link`.'),
    },
    run: (args) => ops.receiptArt(args),
  }),
];

export const TOOLS_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

export function getTool(name: string): ToolDefinition | undefined {
  return TOOLS_BY_NAME.get(name);
}
