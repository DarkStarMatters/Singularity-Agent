# PrivateDAO registry: three things only your side can change

**Server:** `pdao-agent-exchange` v1.4.0 at `https://agents.privatedao.org/mcp`
**Protocol:** 2025-06-18
**Agent:** SingularityAgent, `agent_3884f6355724a1e850d31f45`
**Observed:** 23 September 2026

## Summary

First, thank you. Every blocker in our earlier report
(`docs/privatedao-schema-report.md`) is fixed: the tools publish real input
schemas, the MCP handshake completes, and paid job creation works again. On 23
September we bought a `token.intelligence` job end to end, and it was credited
about a second after we submitted the payment. Details are under
[The paid job that worked](#the-paid-job-that-worked).

We re-registered Singularity the same day so the listing points at our current
endpoint and version. It is now connected with 22 tools and 28 networks. Three
things are left that `register_agent` cannot do, so we need your help:

1. **Retire our stale listing**, `agent_724dd89f22ee9f4527ef1f16`, which still
   points at an address we no longer use.
2. **Allow `mint_audit` and `verify_burn`.** Both only read, but the allowlist
   dropped them.
3. **Tell us how pricing is set**, since `register_agent` has no field for it and
   our listing carries `pricing: {}` and `acceptedAssets: []`.

A fourth, smaller item is under [Also worth knowing](#also-worth-knowing).

## What we sent

One `register_agent` call with `forceRefresh`, after deploying our v0.4.0 build:

```json
{
  "name": "SingularityAgent",
  "protocol": "MCP",
  "mcpUrl": "https://mcp-singularity.cicada71.net/mcp",
  "allowedTools": [
    "chains", "resolve", "balance", "portfolio", "transaction", "history",
    "block", "fees", "read_contract", "mint_audit", "decode", "verify_burn",
    "token_identity", "chain_liveness", "inspect_exit", "inspect_payment",
    "prove_payment", "receipt_art", "mesh"
  ],
  "networks": [
    "ethereum", "base", "arbitrum", "optimism", "polygon", "bsc", "avalanche",
    "gnosis", "scroll", "linea", "zksync", "blast", "mantle", "mode", "fraxtal",
    "opbnb", "solana", "bitcoin", "litecoin", "cosmoshub", "osmosis",
    "celestia", "injective", "dydx", "sei", "neutron", "stride", "kava"
  ],
  "tags": ["external", "mcp", "singularity", "read-only", "multi-chain", "payment-verification"],
  "forceRefresh": true
}
```

It came back `registration_status: "registered"`, `status: "connected"`,
verified at `2026-09-23T16:38:46.392Z`, with 22 tools and 28 networks. The
network aliases were normalized as documented, e.g. `ethereum` →
`ethereum-mainnet` and `solana` → `solana-mainnet-beta`.

We asked for 19 tools. The three `build_*` tools were left out on purpose: they
return unsigned transactions, and your policy is right to keep them out of a
read-only allowlist.

## 1. Retire the stale listing

`search_agents` now returns two entries for us:

| Id | Endpoint | Snapshot | Allowed | Last connected |
| --- | --- | --- | --- | --- |
| `agent_3884f6355724a1e850d31f45` | `https://mcp-singularity.cicada71.net/mcp` | v0.4.0, 22 tools | 17 | 2026-09-23 |
| `agent_724dd89f22ee9f4527ef1f16` | `https://singularity-agent.cicada71.net/api/mcp` | v0.2.0, 18 tools | 1 (`chains`) | 2026-09-20 |

**The request:** please delete `agent_724dd89f22ee9f4527ef1f16`.

Why it matters: an agent searching the registry sees two SingularityAgents that
disagree about what they can do, and nothing marks which one is current. The old
entry will not be evicted by a health check either, because the old address
still answers — it serves the same deployment under a legacy hostname. From
outside it looks healthy and simply out of date.

Registration appears to be keyed by URL, so re-registering under a new endpoint
creates a new listing rather than updating ours, and no tool removes one. Any of
these would stop this happening again, to us or to the next agent that moves
endpoint:

- an `unregister_agent` tool, callable against a listing the caller registered;
- a `replaces` field on `register_agent` naming the id it supersedes;
- matching an existing listing by `name` plus the MCP `serverInfo.name` it
  reports (`singularity-agent` for both of ours), as well as by URL.

## 2. Allow `mint_audit` and `verify_burn`

We asked for 19 tools and 17 were allowed. The two dropped are read-only on every
axis your policy names — "financial, signing and destructive tools blocked":

| Tool | What it does | Annotations it advertises |
| --- | --- | --- |
| `mint_audit` | Reads a token's authorities and supply from its mint account. No transaction is built. | `readOnlyHint: true`, `openWorldHint: true` |
| `verify_burn` | Reads a finalized transaction and reports whether it burned a token, which mint, and how much. It builds nothing and spends nothing. | `readOnlyHint: true`, `openWorldHint: true` |

Neither signs, builds, moves funds or changes state. Both annotations are in the
`tools/list` your registration snapshot already holds.

Our guess, which only you can confirm: the filter matches words in the tool name,
and "mint" and "burn" read as financial. If so, classifying on the MCP
annotations would be more reliable in both directions. Our `build_burn`,
`build_transfer` and `build_payment` also carry `readOnlyHint: true`, because
they return unsigned bytes and never touch a key, so the name is doing real work
in your filter. We are happy to rename or add annotations if a convention would
make this easier to classify — tell us which one.

**The request:** add `mint_audit` and `verify_burn` to our `allowed_tools`, or
tell us what would get them through the policy.

## 3. How does pricing get set?

Our listing carries `pricing: {}` and `acceptedAssets: []`. `register_agent`
advertises no field for either — its schema is `name`, `protocol`, `mcpUrl` (or
`mcp_url` / `endpoint`), `allowedTools`, `tags`, `networks`, `forceRefresh` and
`persistUnavailable`, with `additionalProperties: false`, so a pricing field we
invented would be rejected.

We would like several of our tools to be buyable through the exchange the same
way yours are. The obvious candidates are the ones whose answers state their own
limits: `mint_audit`, `inspect_exit`, `inspect_payment`, `prove_payment` and
`mesh`. Before we can propose numbers we need to understand your model:

- **Where the price lives.** Is it per tool, per call, or per listing? Is it set
  by the agent or by the exchange?
- **Which assets.** Is USDC on `solana-mainnet-beta` the only settlement asset,
  as it is for your own services?
- **How payment reaches the seller.** Does the buyer pay us directly, or do you
  pay us out from your treasury, and on what terms?
- **How a sold call is run.** Does the exchange call our endpoint on the buyer's
  behalf after payment, as `agent.match` suggests, or does the buyer?

Whatever the shape, we would suggest it goes into `register_agent` (for example
`pricing: { "<tool>": { "amount": "0.02", "asset": "USDC" } }` alongside
`acceptedAssets` and a payout address), so an agent can price itself without a
manual step on your side.

**The request:** tell us how pricing is meant to be set, or set it on your side
once we agree numbers.

## The paid job that worked

Recorded here as evidence that the payment path now works end to end, and because
your receipts turned out to be the best-behaved part of it.

| Step | Result |
| --- | --- |
| Service | `token.intelligence` on the USDC mint, 0.03 USDC |
| Job | `job_33640e3c-5bdb-42bb-a250-129840776b37`, quote `q_e61d20dc-8ed1-4c30-a1d1-1bac487fdfea` |
| Checked before signing | Destination `5RyKShQxSkbUJ9vA2MZ1Qf2TKgnwhhS3m7mj2ZZaVh6t` exists, holds USDC and belongs to `2BJ4ezxqV9YJXc38D9duKBkdn4su4jE1beKUHwH663sL`. Amount agrees in both units. Simulated delivery was exactly 0.03 USDC. |
| Payment | `3C4s5ngiJP23vABg8h3rKWwZVnUaYNmaa3EhY3NhrdcBrMBdgqk3hkpdFEBqytGFEnZrVnQLRt6nHYb3nYXsYq6f`, finalized in slot 449714898 at 13:18:59 UTC, with memo `PDAOJOB:job_33640e3c-…` |
| Credited | `completed` about 1s after the signature was posted. Receipt `rvr_fe53c65da876a1798a5b6ae36af3f27e`, `VERIFIED`. |
| Receipt re-derived | `input_hash` and `result_hash` both reproduce as SHA-256 over sorted-key JSON of the input we sent and the result we received. |

The last row is worth saying plainly: we could check your receipt without taking
your word for it, which is exactly what a receipt should allow. Our client now
ships that check as `checkReceipt`, and our new `prove_payment` tool does the
same for the payment side, from the chain alone.

## Also worth knowing

**The MCP `submit_payment` tool does not submit.** Called with a valid `job_id`
and a finalized signature, it returns
`{"status":"use_http_payment_endpoint","required":["job_id","signature"]}` and
the job stays unpaid. The payment only counts when it is POSTed to
`/api/jobs/<id>/payment`. A client that follows the MCP tool, which is the only
thing a model sees, pays and then is told nothing. Two fixes would each close it:
have the tool perform the same submission the HTTP endpoint does, or say in its
description (currently `"PrivateDAO submit_payment"`) that it will not, and where
to go instead. We have worked around it on our side; the next agent will not know
to.

## What we will do on our side

- Keep our endpoint at `https://mcp-singularity.cicada71.net/mcp`. We will not move it
  again without asking you first, given item 1.
- Re-register with `forceRefresh` after every release that changes the tool list,
  so the snapshot stays current.
- Propose concrete prices as soon as we know how pricing is modelled.

Thank you for turning the first report around as fast as you did. This one should
be smaller.
