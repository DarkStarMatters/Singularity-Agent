# Singularity Agent

**A normalization layer for agentic blockchain access**

Version 0.0.4 · MIT licensed · [github.com/DarkStarMatters/Singularity-Agent](https://github.com/DarkStarMatters/Singularity-Agent)

---

## Abstract

Language models can reason about blockchains but cannot reliably *touch* them. The
obstacle is not intelligence, it is surface area: four chain families, four address
encodings, four transaction shapes, four ways to be wrong about decimals. An agent
handed four SDKs spends its context reconciling them instead of answering the question.

Singularity Agent puts one normalized, read-only surface over EVM, Solana, Bitcoin/UTXO,
and Cosmos — 23 chains today — exposed simultaneously as a terminal CLI and as ten MCP
tools. It holds no private keys. It can build an unsigned transaction for a human to sign
in their own wallet; it cannot sign, and it cannot broadcast.

The design claim is narrow and testable: **the hard part of agentic blockchain tooling is
not reaching the chain, it is shaping what comes back.** A tool that returns everything is
not neutral — it is unusable. Most of the engineering here is in what the tools decline to
say, and in how they say what they could not.

---

## 1. The problem

### 1.1 Four SDKs, four dialects

A developer asking "what does this address hold?" writes different code per family, and
each dialect disagrees on fundamentals:

| | EVM | Solana | Bitcoin | Cosmos |
|---|---|---|---|---|
| Address | 20-byte hex, EIP-55 case checksum | base58 32-byte pubkey | base58check *or* bech32, version-tagged | bech32 with a per-chain HRP |
| Balance | `eth_getBalance` + per-token `balanceOf` | lamports + token accounts | sum of UTXOs | coin vector per denom |
| Enumerable holdings | **No** — needs an indexer | **Yes** — accounts are owned | N/A | **Yes** |
| Fee model | gas × gwei (EIP-1559) | fixed lamports/signature | sat/vB × tx size | gas × denom |
| Tx identity | 32-byte hash | 64-byte signature | txid (byte-reversed) | 32-byte hash |

These are not cosmetic differences. Bitcoin fees depend on how many UTXOs you spend, not
on the amount sent. EVM holdings cannot be enumerated without an indexer, while Solana
holdings can. A wrapper that flattens these into one shape and stops there is lying by
omission; a wrapper that exposes them raw has normalized nothing.

### 1.2 Why agents fail specifically

Three failure modes are particular to models rather than humans:

**Decimals.** A float `0.1` ETH is 18 decimal places of opportunity to be wrong. A model
that emits base units where the API wanted a decimal string — or the reverse — sends
10¹⁸× the intended amount. This is the single highest-severity bug class in the domain,
and it is silent.

**Ambiguity treated as certainty.** 64 hex characters is a valid transaction hash on
Ethereum, Bitcoin, *and* Cosmos simultaneously. A tool that picks one and returns "not
found" teaches the model a false negative. A tool that says *ambiguous, here are the
candidates* lets it proceed correctly.

**Context exhaustion.** This is the one the literature underrates, and §4 is a measured
case of it. A tool result is not free. A response large enough to consume the budget is
not a large answer — it is a **failed call**, and it fails after the network cost has
already been paid.

### 1.3 The custody problem

An agent with signing authority is an agent that can lose funds irreversibly, with no
chargeback and no undo. The industry answer has been to bolt confirmation prompts onto a
tool that *can* sign. That is a policy control on top of a capability.

Singularity takes the capability away. There is no key material in the process, no
signing code path, no broadcast endpoint. `build_transfer` returns an unsigned payload
and hands it back to the human. This is not a limitation to be lifted later — it is the
architecture, and §3.4 argues it should stay.

---

## 2. Architecture

```
┌──────────────┐   ┌──────────────┐
│  CLI (human) │   │  MCP (model) │     Two front ends, one core.
└──────┬───────┘   └──────┬───────┘     Neither owns logic the other lacks.
       └────────┬─────────┘
                ▼
       ┌─────────────────┐              Resolution, validation, formatting,
       │   operations    │              error shaping. Family-agnostic.
       └────────┬────────┘
                ▼
       ┌─────────────────┐              One interface, four implementations.
       │  ChainAdapter   │              Families differ below this line only.
       └────────┬────────┘
    ┌───────┬───┴───┬────────┐
    ▼       ▼       ▼        ▼
   EVM   Solana  Bitcoin  Cosmos
  viem   web3.js  esplora   LCD
```

~4,600 lines of TypeScript, 76 tests, six runtime dependencies.

### 2.1 The adapter contract

Every family implements one interface: address validation, native balance, token
balances, transaction, block, fees, unsigned transfer, health probe. The `operations`
layer above it never branches on family except where the difference is *semantic* and
must reach the caller.

The interface is deliberately allowed to be asymmetric where chains genuinely are.
`getTokenBalances` returns either a bare array — the list is complete as it stands — or a
`TokenScan { entries, note }` when the scan had to leave something out. Bitcoin's
implementation throws, because Bitcoin has no token concept, and `getBalance` catches
that and reports it as a note rather than a failure. **A chain that cannot answer a
question is not an error; it is an answer.**

### 2.2 Arithmetic

Every amount is `bigint` end to end. Balances return both raw base units and a formatted
string, so the caller never re-derives one from the other:

```json
{ "raw": "6712597953701629485", "formatted": "6.71259795",
  "decimals": 18, "symbol": "ETH" }
```

`parseUnits` refuses to silently truncate precision rather than quietly send the wrong
amount, and public entry points take human decimal strings only — `"1.5"`, never base
units. The type system is doing the safety work, not the prompt.

### 2.3 Failure as data

Public RPC endpoints throttle by IP and disappear without notice, so failover is the
normal path rather than an exception. Every chain carries an ordered endpoint list; each
call walks it. Domain errors — a missing account, a bad mint — are rethrown immediately,
since retrying those elsewhere is just slower and equally wrong.

MCP errors return as structured results carrying a code and a hint, never as transport
exceptions. A transport exception ends the model's turn; a structured error lets it
correct itself:

```
INVALID_ADDRESS  "cosmos1qypqx…lzv7xu" is not a valid address on Osmosis.
That is a "cosmos" address. It is the same account on Osmosis, re-encoded:
osmo1qypqxpq9qcrsszg2pvxq6rs0zqg3yyc5helwsw
```

The error does not merely reject. It hands back the corrected input.

---

## 3. Design principles

### 3.1 Skipped is not failed

`portfolio` queries one address across many chains in parallel. Asked for a `0x` address
on eight chains including Solana and Bitcoin, it returns six results, an empty `errors`
array, and a `chainsQueried` list naming only the six.

The two inapplicable chains were **skipped, not attempted and failed**. The distinction
matters more for a model than a human: a human glances past two red rows, while a model
must spend tokens deciding whether they indicate a real problem, and may retry them.
Noise in a tool result is not cosmetic — it is a tax on every subsequent inference.

### 3.2 A tool must state its own limits

EVM token balances come from scanning a curated list, because enumeration is impossible
without an indexer. Every such response carries the caveat inline:

> EVM chains cannot be enumerated without an indexer, so this covers a curated list of
> major tokens only. Pass `tokens` with contract addresses to check others.

Balances carry no fiat pricing, and say so. This is not hedging. A model that receives a
partial list unlabelled will present it as a complete one, and the user will act on it.
**The caveat is part of the payload, not documentation.**

### 3.3 The recipient is not the `to` field

`build_transfer` for a token returns a payload whose `to` is the *token contract*, with
the actual recipient encoded in calldata. This trips up humans reading wallet UIs
constantly. The response says so unprompted:

> This calls `transfer()` on the token contract. `to` is the TOKEN address, not the
> recipient — the recipient is encoded in `data`. Sign with your own wallet.
>
> ⚠️ This transaction is unsigned. Review every field before signing.
> ⚠️ Verify the token address belongs to the asset you mean. Fake tokens reuse real symbols.

### 3.4 Read-only is a feature, not a phase

The most requested future capability will be signing. It should be declined.

Read-only is what makes the tool safe to hand broad autonomy. The moment keys enter the
process, every downstream integration inherits a custody question, the threat model
changes from "wrong answer" to "lost funds," and prompt injection through on-chain data —
a token whose *name* is an instruction — escalates from nuisance to exploit. The unsigned
payload is the correct boundary: Singularity composes the transaction, a wallet the user
already trusts authorizes it. Two systems, two trust domains, one deliberate seam.

---

## 4. A measured case: the cost of answering completely

During a live walkthrough, `balance` was pointed at a Solana exchange hot wallet. It
returned **1,268,291 characters across 49,244 lines** — over the MCP tool-result budget.
The call did not return a large answer. It **failed**, after paying full network cost.

Two causes, both instructive.

**Unbounded enumeration.** Solana is the one family where holdings *can* be enumerated,
and that was the trap. Anyone can airdrop a token account onto any wallet, so an active
address accrues dust indefinitely: this one held **3,075 mints**, of which ~3,065 were
unnamed. EVM's inability to enumerate had been accidentally protecting it.

**Unaggregated accounts.** A wallet may hold several token accounts for one mint. They
were listed separately, so a single USDC holding appeared as two rows — 1095.074585 and
1.0. Any consumer summing that list double-counts. This was the subtler bug: the response
was not too big, it was *wrong*, and wrong in a way that looks plausible.

The resolution follows §3.2 rather than simply lowering a limit. Accounts are summed per
mint, with a `tokenAccounts` field recording how many were combined. Unfiltered scans
sort curated tokens first, then by balance, and cap at 50 — with a note that names the
omission and refuses to imply a ranking it cannot support:

> Showing 50 of 3075 mints held — curated tokens first, then by raw balance. 3025
> omitted, and because there is no pricing here that order is magnitude, not value. Pass
> `tokens` with mint addresses to check specific holdings.

An explicit `tokens` list is never capped: that is the caller naming exactly what they
want, and truncating it would be second-guessing an unambiguous request.

**Result: 1,268,291 → 22,291 bytes. A 57× reduction, and the previously-failing call now
succeeds.** No information the user could act on was lost; what was removed was
unactionable by construction, since ranking 3,000 unpriced dust mints is not a thing the
tool can honestly do.

The general lesson, and the paper's central claim: *the constraint on agentic tool design
is not capability but attention.* A tool that answers completely can be strictly worse
than one that answers partially and says so.

---

## 5. Limitations

Stated plainly, because §3.2 applies to this document too.

- **EVM token lists are curated, not exhaustive.** Structural, absent an indexer.
- **No fiat pricing.** Deliberate — it would require a trusted oracle and turn a
  deterministic tool into one with a market-data dependency and a staleness question.
- **No historical queries.** Balances are current-state only; no "as of block N."
- **Public RPCs are rate-limited.** Fine for interactive use, insufficient for sustained
  automation without configured endpoints.
- **Solana history is pruned.** Public RPCs drop older signatures; archival access needs
  a dedicated endpoint.
- **No transaction simulation.** `build_transfer` constructs a payload but does not
  predict its effects.
- **On-chain strings are untrusted input.** Token names and symbols, Cosmos denoms and
  memos, revert strings, Solana program logs and decoded `string` arguments are all
  attacker-controlled and all reach the model. Every one of them now travels marked
  `untrusted` and defanged of anything that could forge structure, and nothing read off
  the chain is interpolated into a `summary` or a `note` — the fields that read as the
  tool's own voice. A symbol, or a long name, that collides with a known asset at another
  address carries an `impersonation` naming the real one. What survives by necessity is
  plain English: the wallet really does hold a token by that name, so the mark is the
  defense and the stripping only stops it being bypassed. See roadmap Phase 2.

---

## 6. Conclusion

Singularity Agent argues that the useful unit of work in agentic blockchain tooling is
not chain coverage but **response discipline**: normalizing what can be normalized,
refusing to flatten what cannot, and making every partial answer announce its own
partiality.

The read-only boundary is the second claim, and the load-bearing one. An agent that
cannot sign can be trusted with far more autonomy than one that can — and the unsigned
payload loses nothing, because the human was going to review the transaction anyway.

Coverage is the easy axis and the roadmap extends it. The discipline is the hard part,
and it is what the 57× measurement in §4 is really about.

---

*Singularity Agent is MIT licensed and holds no private keys. It cannot sign or broadcast
transactions. See [roadmap.md](roadmap.md) for planned work.*
