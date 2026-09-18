# Singularity Agent v0.0.9

**One read-only blockchain surface for agents — EVM, Solana, Bitcoin and Cosmos — now one
command away, and now able to tell you when a chain has stopped.**

Four chain families normally mean four SDKs, four address formats, four sets of field
names, and four ways to be wrong about decimals. Singularity puts one normalized surface
over all of them, for a human at a terminal and for a model over MCP. It holds no private
keys: it can build an unsigned transaction for you to sign in your own wallet, and it
cannot sign or broadcast.

---

## Install it in one line

```bash
npx singularity-agent chains
```

No clone, no build step. For the MCP server, in Claude Code or any MCP client:

```bash
claude mcp add singularity -- npx -y -p singularity-agent singularity-mcp
```

That is the whole setup. Previously every path started with cloning the repo and running
a build, which is a lot of ceremony in front of a tool whose entire pitch is removing it.

## `chain_liveness` — ask whether a chain is actually producing blocks

This is the feature we care most about, and it exists because "is this endpoint
reachable?" is a weaker question than it looks.

A chain that has halted does not go dark. It answers every request it is given, with the
correct chain id, forever, serving the last block it ever made. Nothing in the response
says so. A balance read from it is historical state carrying no indication that it is
historical — and an agent will act on it exactly as if it were current.

So `chain_liveness` asks three questions reachability cannot:

- **How old is the head block?** The only question that sees a halt at all.
- **Do the endpoints agree?** Failover takes whichever endpoint answers first, so a single
  endpoint hours behind makes reads go stale *intermittently* — which is harder to notice
  than a chain that is stale always.
- **How many endpoints actually answer?** Two configured endpoints and two working ones
  are different facts.

Every endpoint is probed on its own rather than through failover, because failover exists
to paper over exactly the difference being measured. The answer is one of seven statuses,
and only the first means a read can be trusted:

| status | meaning |
| --- | --- |
| `live` | producing blocks, endpoints agree, failover intact |
| `stale` | the head is old enough that nothing here is current state |
| `lagging` | endpoints disagree enough that which one answers changes the answer |
| `single` | only one endpoint answered, so the next failure is total |
| `undatable` | answering, but nothing will say when the head was produced |
| `skewed` | the head is dated in the future, so its age proves nothing |
| `down` | nothing answered |

Thresholds are per chain family and deliberately generous — the question is not whether an
endpoint is two blocks behind, it is whether the state being served is categorically not
current. An undated or future-dated head reports as undatable rather than fresh, because a
chain that cannot be dated must never come out looking live.

From the terminal:

```bash
singularity doctor              # every chain, worst first
singularity doctor --endpoints  # every endpoint, not only the broken ones
singularity doctor -c ethereum --json
```

It exits non-zero on a stale or down chain, so it drops straight into CI or a cron check.
It is also `/health` on the Telegram bot, and the sixteenth tool on the MCP surface — an
agent can now ask whether the chain it is about to read is current *before* it reads it.

---

## What else is in the box

For anyone arriving new — the rest of the surface, all of it read-only:

- **32 chains across 4 families.** 18 EVM (Ethereum, Base, Arbitrum, Optimism, Polygon,
  BNB, Avalanche, Gnosis, Scroll, Linea, ZKsync, Blast, Mantle, Mode, Fraxtal, opBNB,
  Sepolia and Base Sepolia), Solana and Solana devnet, 3 UTXO chains (Bitcoin, Bitcoin
  testnet, Litecoin), and 9 Cosmos chains (Cosmos Hub, Osmosis, Celestia, Injective, dYdX,
  Sei, Neutron, Stride, Kava).
- **Balances, portfolios, transactions, history, blocks, fees** — normalized to the same
  shape on every family, so a Bitcoin balance and an Osmosis balance come back with the
  same field names.
- **Every result states what it covers.** A token list says whether it is exhaustive,
  curated, truncated or failed. An empty list is never allowed to stand in for "this
  wallet holds nothing" when what happened was that the scan failed.
- **Amounts are never floats.** `bigint` end to end, raw base units and a formatted string
  on every balance. Where a chain does not publish a denom's decimals, the amount is shown
  in base units and marked as such rather than guessed at.
- **Response budgets.** Callers say how much room they have — `small`, `standard`, `full`,
  or an exact count — and a budget can never quietly shorten an answer: the entries and
  the completeness claim come back together.
- **Unsigned transaction and burn builders.** It hands back a payload for your own wallet.
  No key storage, no seed handling, no signing, ever — that is a permanent non-goal, not a
  missing feature.
- **`decode`, `mint_audit`, `token_identity`.** Decode calldata all the way down through
  batches and receipts; ask what a Solana mint permits (can more be printed, can you be
  frozen); and check whether a token wearing a familiar ticker is actually the mint it
  claims to be.

918 tests, MIT licensed.

**[github.com/DarkStarMatters/Singularity-Agent](https://github.com/DarkStarMatters/Singularity-Agent)**
