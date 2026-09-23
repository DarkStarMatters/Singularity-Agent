# Singularity Agent v0.5.0

**A payment can land and never count. This release is for the party who paid.**

```bash
npm install singularity-agent
```

Everything Singularity checked about a payment was on one side of it: whether a demand
*can* be paid, and — for whoever is owed — whether it *was*. Nothing answered for the
payer. v0.5.0 does, with a twenty-second tool, a two-command way to buy a job on an agent
exchange, and a receipt you re-derive instead of trust.

`singularity-sdk` stays at **v0.2.0**. It reads its tools from the agent's catalogue, so
it gets `prove_payment` without a change of its own, and its peer range now asks for
v0.5.0.

---

## Landed is not credited

In September we paid a live agent exchange 0.01 USDC for a machine-priced service. The
demand checked out, the transaction simulated clean, landed and finalized — the right
amount, to the exact account named, carrying the job reference. The job was never
credited, and the exchange's answer was that the quote had expired, for a payment made
three seconds after it was issued.

Everything this project could say about that payment was true, and none of it helped,
because all of it was about whether the payment *could* land. What the payer needed was
evidence that it met the deal, assembled from the chain by the party who paid — not a
receipt from the party who had just declined to issue one.

---

## `prove_payment`

A signature and the terms of the demand it answered — payee, amount, mint, the exact
token account, memo, deadline, payer. Each term is its own check, expected beside
observed, against finalized state only:

```bash
singularity provepay <signature> --to <payee> --amount 0.03 --mint <mint> \
  --token-account <account> --memo PDAOJOB:job_… --expires-at 2026-09-23T13:38:50Z
```

```
  proven        finalized, and every term holds

  ✓ tokenAccount
      expected  5RyKShQxSkbUJ9vA2MZ1Qf2TKgnwhhS3m7mj2ZZaVh6t
      observed  5RyKShQxSkbUJ9vA2MZ1Qf2TKgnwhhS3m7mj2ZZaVh6t
  ✓ deadline
      expected  landed by 2026-09-23T13:38:50.376Z
      observed  landed 2026-09-23T13:18:59.000Z
```

The deadline line is the September answer, in the form a payee cannot argue with: the
block time and the deadline, side by side.

`contradicted` means a term does not hold — a real payment can still be the wrong one.
`unproven` means the chain cannot settle it yet: not found, not finalized, or a block
nobody will date. **The two are never merged**, because "we could not tell" and "it is
wrong" call for opposite responses. The CLI exits non-zero on anything but `proven`.

---

## Buying a job, either side of your own signature

```bash
singularity exchange buy token.intelligence --from <wallet> --input '{"network":"solana-mainnet-beta","asset":"<mint>"}'
# sign the unsigned payment in your own wallet
singularity exchange settle <job_id> <signature> --input '<the same json>'
```

`buy` opens the job, checks the demand the exchange issues, and builds the unsigned
payment — or refuses. `settle` proves the payment against the demand **before the
exchange hears about it**, never submits one that contradicts it, waits for one that has
not finalized, submits, polls, and re-derives the receipt.

It answers in six words rather than one, because landed, credited and verified have
already come apart once: `verified`, `credited`, `pending`, `failed`, `refused`,
`unproven`. Only `verified` exits 0.

The package still cannot sign. `buy` stops at an unsigned transaction, and `settle`
starts from a signature something else produced.

---

## A receipt you re-derive

The exchange issues a receipt with an input hash and a result hash. `checkReceipt`
recomputes both from what you actually sent and what you actually got back. On the first
job we bought, both reproduced exactly.

That proves the receipt is about *this* job. It does not prove the result is correct, and
the output says so in as many words — a receipt that claimed more than it could would be
the thing this project exists to argue against.

---

## `mesh payment`

The mesh learns a seventh objective: settlement, plus whether the transaction met the
demand it answered.

```bash
singularity mesh payment <signature> --demand '{"to":"…","amount":"0.03","mint":"…"}'
```

Against the job we bought on 23 September it proves all five facts in three calls. Without a
demand it does not guess one; the proof is listed in `unproven` with the missing demand
as the reason, and no call is spent on it.

---

## What the exchange work turned up

Buying for real turned up three things. Our exchange client had no way to submit a
payment at all, and the obvious one — the MCP `submit_payment` tool — answers
`use_http_payment_endpoint` and credits nothing; the client now posts where payment is
actually taken. Two argument shapes recovered from error messages were wrong once the
exchange published real schemas, and now follow them. And an hour spent believing the
exchange was down was the local network silently dropping every connection to AWS in
Europe — recorded because a silent timeout looks exactly the same either way.

---

22 tools. 32 chains. MIT licensed. Still read-only, still holds no keys.

**[github.com/DarkStarMatters/Singularity-Agent](https://github.com/DarkStarMatters/Singularity-Agent)**
