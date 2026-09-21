# Singularity Agent v0.3.0 — and `singularity-sdk` v0.2.0

**The other side of the table: somebody hands you an invoice, and the only question that
matters is whether signing it does what it says.**

```bash
npm install singularity-agent singularity-sdk
```

Two new tools, `inspect_payment` and `build_payment`, take the count to twenty. Still
read-only in the sense that has always mattered: nothing here signs, and `build_payment`
returns a payload for a wallet the same way `build_transfer` always has.

---

## The invoice that is consistent with itself and inconsistent with the chain

Every payment surface in v0.2.0 was written for whoever is asking to be paid. This release
is the other side.

A live agent marketplace quoted an invoice for 0.01 USDC. It named the asset, the amount in
two forms, a treasury owner and the exact token account to pay into. Every field was
well-formed and consistent with every other field.

The mint was one character short of USDC's — a valid base58 pubkey for a mint that has never
existed. The token account was the associated account derived from that non-existent mint,
so it had never existed either. Signing it would have failed. A client that helpfully
created the destination first would have paid rent on an account the payee was not watching.

**Nothing in the signing path would have said a word**, because a wallet confirmation screen
never reads the chain. That is the shape of the dangerous ones: not malformed, but
self-consistent and chain-inconsistent.

`inspect_payment` takes a demand as it arrived and checks each claim separately:

| Claim | Checked against |
| --- | --- |
| The ticker matches the mint | The curated map, offline |
| The destination exists | The chain |
| It holds *that* mint, and belongs to the payee named | The chain |
| The displayed amount, the base units and the decimals agree | The mint's own decimals |

Base units are the part that actually gets signed, which is why they are checked against the
mint rather than against the invoice's own prose.

**`verdict` is three values, not a boolean**, and `unproven` is the one that earns its place:
an endpoint that would not answer is not evidence about the demand. The CLI exits non-zero on
`unproven` as well as on `unpayable`, because a script that reads "I could not check" as "go
ahead" is the failure this exists to prevent.

`unpayable` means the demand is wrong — never that the counterparty is dishonest. The invoice
above was somebody's configuration typo, and saying so plainly is what makes it worth reading.

---

## A check nobody is obliged to read is a check nobody runs

`inspect_payment` returned a verdict and left the caller free to ignore it. So `build_payment`
runs the same checks and hands back an unsigned transaction **only when they pass**. Unpayable
stops being advice and becomes a refusal with nothing to sign — the decision `build_burn`
already made about burns that cannot land. Unproven refuses too.

The warnings travel with the payload rather than staying behind in a report. Whatever the
check accepted with reservations — a fee-bearing mint, a contract payee, a memo the chain
cannot carry — goes into the transaction's own `warnings`, because that is the last text read
before a signature.

On Solana the demand's `reference` is attached to the transfer as a read-only account rather
than dropped, so the payee can match the payment to the order without trusting the payer to
quote anything.

Which exposed a gap worth its own finding: **a demand can insist on a memo, and a plain
transfer on EVM has nowhere to put one.** Paid as an ordinary transfer it lands and is not
credited, which looks exactly like not having paid — the worst shape a payment failure takes.
Reported as a warning rather than a refusal: the payment is real, the credit is the risk.

---

## Measuring what a payment delivers, instead of reasoning about it

The roadmap recorded a hole in writing: **a fee-on-transfer ERC-20 is invisible to the standard
interface**, because the behaviour lives inside `transfer` itself. There is no field to read.
`inspect_payment` reports such a demand payable, the payer sends the amount demanded, the payee
receives less, and every fact checked out.

Simulation closes it, and the prize is not the revert check. It is the arithmetic:

> Read the recipient's balance. Execute. Read it again. Subtract.

A transfer fee, a skimming hook and a rounding surprise all surface the same way, without
anyone having to anticipate the mechanism. That is a different kind of check from naming known
mechanisms, because it measures the outcome.

`build_payment` now executes what it builds and refuses a transaction that reverts. A demand
whose facts check out can still produce a payment that cannot land, and handing that back helps
nobody — signing it spends a fee to fail. A **shortfall** is not a refusal: the payment is real
and the gap may be exactly what both parties expect, so it rides on the payload as a warning
where a signer reads it.

**The asymmetry is reported rather than smoothed over.** Solana measures through
`simulateTransaction` post-state. EVM measures through `eth_simulateV1`, which is not universal
— Base and publicnode serve it, some do not — so where it is refused this falls back to
`eth_call` and says the delivery **was not measured**, rather than reporting it as delivered. An
unmeasured delivery presented as a successful one would be worse than no simulation, because it
would carry the authority of one.

The shortfall note deliberately does not say *why*. A transfer fee, a hook that skims, and a
transaction built for a different amount than the one quoted are indistinguishable from a
subtraction. Naming the likeliest as though it were the finding is the unsupported confidence
this tool refuses everywhere else — a first draft did exactly that, and was wrong on the first
case run through it.

### `scripts/verify-builders.mjs`, and why it is not in `npm test`

The builders emit bytes — instruction discriminators, account orderings, struct offsets,
calldata — and a test written from the same understanding that produced the bytes agrees with
them whether or not they are right. The QR encoder taught that once already: two bugs, every
test agreeing with both.

So the chain is asked instead. Twenty-five checks against mainnet, covering the
associated-token-account instruction, the token account offsets, the EIP-7702 designator and the
ERC-20 calldata. It needs the network, and putting it in CI would train people to ignore CI.

```bash
npm run verify:builders
```

---

## A live run, including the part that did not work

The invoice above was refused with nothing built and exit 1. It was reported upstream, the
malformed mint constant was fixed, and a real payment then went through: **0.01 USDC, finalized,
with the job reference as a memo**, simulated at `err: null` and 45,681 compute units beforehand
and landing exactly as simulated. The recipient had never held the token, so the transfer created
the destination account first — which is what `ataRequired: true` asks the payer to do.

**The job was never credited.** The payment endpoint answered `quote expired` for a payment that
landed three seconds after the quote was issued, and still answers that on every retry.

That is somebody else's bug, it is written up and sent with the timings and the signature, and it
belongs in these notes anyway — because it is the cleanest demonstration this project has of its
own central claim:

> `level: final` is a fact about the chain. It is not a fact about the counterparty's ledger.

A rail that had returned `paid: true` would have been correct about the chain and useless about
the outcome.

---

## Holdings, the way people actually hold them

`portfolio` took one address, and nobody holds anything that way — an EVM address, a Solana
pubkey and a Bitcoin address are one person's holdings and were three separate questions. It
takes a set now.

The fan-out is deliberately **not a cross product**: each address is matched only to the chains
its own format is valid on, so a Solana pubkey never produces twenty EVM errors and a Bitcoin
address costs one query rather than thirty. An address valid on nothing requested lands in
`errors` instead of failing the call.

The hard half is deciding what may be added to what. A total is a claim, and there is one place
one can be made honestly: the same token, on the same chain, across the addresses you gave.

It refuses two sums, and both refusals are the point:

- **It will not add a token to itself across chains.** USDC on Ethereum and USDC on Base are
  different contracts with different issuers of record; bridged supply can be frozen and the two
  can trade apart. They are listed side by side with a sentence saying why there is no single
  number, rather than leaving the absence to be inferred.
- **It will not merge two contracts because they share a name.** Grouping by symbol is exactly
  the operation an impersonating token is deployed hoping somebody performs. Only curated symbols
  group by name at all; anything whose symbol was read off the chain is keyed by its address and
  stands alone, however familiar it looks.

Still no fiat pricing, and so still no portfolio value. A value needs a price, a price needs a
source, and that is a different kind of claim from a balance read off a chain.

---

## Served over HTTP, and a site that is the product

The MCP endpoint is served over HTTP at `mcp-singularity.cicada71.net`, from the same catalogue
as the local server. So the documentation and the product can be the same thing: a visitor who
has installed nothing is still using it, and the worst they can do with it is look something up.

The page asks Ethereum, Base, Solana and Bitcoin for their newest block on load, runs `resolve`
on whatever you paste, and executes real CLI commands against any of the 32 chains. Replay mode
keeps recorded transcripts for when a free public node is having a bad day, and **labels them as
recordings** — a stale number that looks current is the failure this project is arranged against.

---

## The count that had drifted

The tool count is written in prose, in four files, in two spellings. `inspect_payment` and
`build_payment` were added and every one of those places kept saying eighteen — including the
site's tools table, which listed eighteen rows, so the two newest tools were the two a visitor
could not find.

Nothing failed, because a wrong number type-checks. `test/tool-count.test.ts` derives the count
from the catalogue and holds all four copies to it, and additionally asserts the site's table has
one row per tool **naming the same tools** — the heading can be right while the table is short,
which is what happened. Both failure modes were planted and confirmed to turn it red, because a
scanner that passes on a clean tree proves nothing.

---

## Two versions, still on purpose

`singularity-sdk` goes to **v0.2.0**. `portfolio` widened from one address to a set, and an API
that grew a new shape answering to a patch number misleads whoever reads the registry. The change
is additive — `address` still works — so nothing published against v0.1.0 breaks.

The agent goes to **v0.3.0**. Sharing one number would make the SDK look nine releases more
settled than it is.

---

20 tools. MIT licensed. Still read-only, still holds no keys — with the one documented receipt-mint
exception carried over from v0.2.0, which signs for the creation of an account and nothing else.

**[github.com/DarkStarMatters/Singularity-Agent](https://github.com/DarkStarMatters/Singularity-Agent)**
