# Singularity Agent

A universal CLI and MCP plugin for interacting with blockchains — one interface across
**EVM**, **Solana**, **Bitcoin/UTXO**, and **Cosmos**.

Four chain families normally mean four SDKs, four address formats, four sets of field
names, and four ways to be wrong about decimals. Singularity puts one normalized surface
over all of them, for both a human at a terminal and a model over MCP.

**It is read-only and holds no keys.** It can build unsigned transactions for you to sign
in your own wallet; it cannot sign, and it cannot broadcast.

---

## Install

```bash
npm install
npm run build
```

Then either link it globally:

```bash
npm link          # provides `singularity` and `singularity-mcp`
```

…or run it straight from source with no build step:

```bash
npx tsx src/cli/index.ts chains
```

### As a Claude Code plugin

The repo ships a plugin manifest. Point Claude Code at this directory and the MCP server
is registered automatically:

```
/plugin install /path/to/Singularity-Agent
```

### As a plain MCP server

Add to your MCP client config:

```json
{
  "mcpServers": {
    "singularity": {
      "command": "node",
      "args": ["/path/to/Singularity-Agent/dist/mcp/server.js"]
    }
  }
}
```

---

## Quick tour

```bash
# What is this string? Works for addresses, tx hashes, ENS/SNS names.
singularity resolve vitalik.eth

# Balances on one chain — names and aliases accepted.
singularity balance vitalik.eth --chain ethereum

# One address across every chain its format is valid on.
singularity portfolio 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045

# A transaction, searched across chains when you don't say which.
singularity tx 0xc29d74412da1bec4e662a7978c3ef993beed7833219d3362a2abca09700fdaa5

# ...or name the chain to skip the search.
singularity tx <txid> --chain bitcoin

# Fee conditions, normalized to "what a simple transfer costs".
singularity fees --chain bitcoin

# Turn opaque calldata into a function call.
singularity decode 0xa9059cbb000000000000000000000000d8da6bf26964af9d7eed9e03e534\
15d37aa9604500000000000000000000000000000000000000000000000000000000000f4240

# Build an UNSIGNED transfer for your own wallet to sign.
singularity build --chain base --to vitalik.eth --amount 25.5 --token USDC

# Which of your configured endpoints are actually up?
singularity doctor
```

Add `--json` to any command for machine-readable output.

---

## MCP tools

| Tool | What it does |
| --- | --- |
| `chains` | List supported chains, with families, ids, aliases, native assets. |
| `resolve` | Identify an address / tx hash / name and which chains it belongs to. |
| `balance` | Native + token balances on one chain. |
| `portfolio` | One address across many chains in parallel. |
| `transaction` | Fetch and normalize a transaction, decoding EVM calldata. |
| `block` | A block by height, hash, or `latest`. |
| `fees` | Current fee conditions, normalized. |
| `read_contract` | EVM view calls; parsed account data on Solana. |
| `decode` | Decode EVM calldata into a signature and arguments. |
| `build_transfer` | Build an **unsigned** transfer payload. |

Every tool is annotated `readOnlyHint: true`. Errors come back as structured results
carrying a code and a hint, rather than as transport exceptions — so a model can correct
itself instead of stalling.

---

## What makes it practical

**It figures out what you pasted.** `resolve` distinguishes an EVM address from a Solana
one, a Bitcoin legacy address from a Solana pubkey (base58check checksum, not shape), and
a tx hash from an account. Where a string is genuinely ambiguous — 64 hex characters is a
valid tx hash on Ethereum, Bitcoin, and Cosmos at once — it says so instead of guessing.

**Cosmos prefixes stop being a trap.** `cosmos1…` and `osmo1…` are the same account,
re-encoded. `resolve` lists the equivalents, and using the wrong one hands you the right
one back:

```
INVALID_ADDRESS  "cosmos1qypqx…lzv7xu" is not a valid address on Osmosis.
That is a "cosmos" address. It is the same account on Osmosis, re-encoded:
osmo1qypqxpq9qcrsszg2pvxq6rs0zqg3yyc5helwsw
```

**Amounts are never floats.** Everything is `bigint` end to end, and every balance is
returned as both raw base units and a formatted string. Dust never renders as `0`, and
`parseUnits` refuses to silently drop precision rather than quietly sending the wrong
amount.

**Public RPCs are assumed to be flaky.** Every endpoint list fails over in order, and
`doctor` tells you which are actually reachable.

**Errors carry hints.** An unknown chain suggests near misses; a rate-limited endpoint
names the env var to override.

---

## Configuration

### RPC endpoints

Public endpoints work out of the box but are heavily rate-limited. Override per chain:

```bash
export SINGULARITY_RPC_ETHEREUM=https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY
export SINGULARITY_RPC_BASE=https://base-mainnet.g.alchemy.com/v2/YOUR_KEY

# Comma-separated for failover:
export SINGULARITY_RPC_SOLANA=https://primary.example,https://backup.example
```

The variable name is `SINGULARITY_RPC_` + the chain id, uppercased, with `-` → `_`
(so `base-sepolia` becomes `SINGULARITY_RPC_BASE_SEPOLIA`).

### Config file

`~/.singularity/config.json` (or `$SINGULARITY_CONFIG`):

```json
{
  "chains": [
    {
      "id": "my-rollup",
      "name": "My Rollup",
      "family": "evm",
      "chainId": 123456,
      "nativeCurrency": { "name": "Ether", "symbol": "ETH", "decimals": 18 },
      "rpc": ["https://rpc.my-rollup.example"],
      "explorer": "https://explorer.my-rollup.example"
    }
  ],
  "addressBook": {
    "treasury": "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"
  },
  "portfolioChains": ["ethereum", "base", "solana"]
}
```

Entries whose `id` matches a built-in chain patch it; new ids add a chain. Address-book
names work anywhere an address is accepted:

```bash
singularity balance treasury --chain base
```

---

## Supported chains

**EVM** — Ethereum, Base, Arbitrum, OP Mainnet, Polygon, BNB Smart Chain, Avalanche,
Gnosis, Scroll, Linea, ZKsync Era, Sepolia, Base Sepolia. Any other EVM chain works via
the config file.

**Solana** — mainnet-beta, devnet.

**UTXO** — Bitcoin, Bitcoin testnet, Litecoin.

**Cosmos** — Cosmos Hub, Osmosis, Celestia, Injective, dYdX.

---

## Known limits

These are real boundaries, not bugs — worth knowing before you rely on a result.

- **EVM token balances are a curated scan, not an enumeration.** Listing every token an
  EVM address holds requires an indexer. Without one, `balance` checks a list of major
  tokens per chain; pass `tokens` with explicit contract addresses for anything else. The
  output always says so. Solana and Cosmos *can* enumerate, and do.
- **No fiat pricing.** Balances only.
- **IBC denoms show as hashes.** Resolving `ibc/ABC…` to its origin asset needs a
  denom-trace lookup per token; the hash is shown rather than a wrong guess, and decimals
  are assumed to be 6.
- **Cosmos fees use a default gas price.** Cosmos gas prices are per-validator, not
  per-chain. Your wallet will usually re-quote.
- **The Bitcoin builder uses largest-first coin selection.** Fewest inputs, lowest fee,
  but not privacy-optimal.
- **No CosmWasm queries.** `read_contract` covers EVM and Solana only.
- **Solana history is pruned** on public RPCs; older signatures need an archival endpoint.

---

## Development

```bash
npm run typecheck
npm test
npm run dev -- chains        # run the CLI from source
npm run mcp                  # run the MCP server from source
```

Architecture:

```
src/core/       normalized types, chain registry, formatting, bech32/base58 codecs
src/adapters/   one adapter per family, all implementing ChainAdapter
src/tools/      operations shared by both front ends
src/mcp/        MCP server
src/cli/        CLI and terminal rendering
```

Adding a chain family means implementing `ChainAdapter` (`src/core/adapter.ts`) and
registering it in `src/adapters/index.ts`. Anything a family genuinely cannot do throws
`UnsupportedOperationError` rather than returning an empty result — a silent `[]` reads as
"no tokens" and gets repeated as fact.

## License

MIT
