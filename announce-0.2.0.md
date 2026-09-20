# Singularity Agent v0.2.0 — and `singularity-sdk` v0.1.0

**Singularity Pay: payments that answer three questions instead of one, QR codes that are
artwork derived from the payment itself, and receipts a holder can verify rather than
believe.**

```bash
npm install singularity-agent singularity-sdk
```

Everything below is still read-only. The SDK still holds no keys. There is exactly one new
key in this release and it is described in full, near the bottom, rather than mentioned
once and moved past.

---

## A payment is not a boolean

Every payment rail this project looked at answers one question — *did a transaction land* —
and returns `paid: true`. That single boolean hides three separate facts a merchant needs
before shipping anything, and keeping them apart is most of what Singularity Pay is.

**How settled is it?** Four values, not two, and deliberately ordered:

| Level | What it means |
| --- | --- |
| `unpaid` | Nothing found. **Not proof of non-payment** — a pruned RPC and a payment that never happened look identical from here |
| `pending` | A transaction exists, below any commitment worth acting on |
| `probabilistic` | Confirmed, and reversible in principle. Fine for a spinner; not for handing over something you cannot claw back |
| `final` | Finalized. The only level this project will call settled |

"Confirmed" and "finalized" are different claims on Solana and only one is irreversible. A
rail that calls both `paid: true` is asking you to ship goods against a transaction that
can still be dropped.

**Were you paid what you asked for?** A transaction that lands is not a transaction that
paid *you*, in *that* token, for *that* amount. Each of those is a separate check and the
failures are silent — a payment in a lookalike mint with the same ticker lands perfectly
well. `mismatches` names each one, and it is the field to read before `level`.

**Can it be taken back?** The mint's freeze authority and permanent delegate are read when
the intent is created, before the link is ever published, and stored with it so the record
survives the decision.

One more return value, which is the one that stops a real bug:

```ts
const { level, fulfil, mismatches } = await pay.settle(intent.id);
```

`fulfil` is true **exactly once per intent, ever** — distinct from `level === 'final'`,
which stays true on every later call. A reference is public the moment it lands, so the
same payment can be presented twice, and a merchant polling in a loop would otherwise ship
the same order repeatedly. Idempotency as a return value rather than a convention.

---

## The QR encoder, and two bugs that every one of its tests passed

Encoding is hand-rolled — Reed–Solomon over GF(256), mask selection, format information,
the whole thing — because a QR generator is the wrong place to take a dependency. It
shipped with two bugs, and **all of its own tests passed**:

- **Format information written backwards.** The standard numbers the format word 14 down to
  0 and puts bit 14 at (8,0). Walking `i` upward while reading bit `i` wrote the word in
  reverse, so scanners read the wrong mask and the wrong error-correction level.
- **The generator polynomial reversed.** Every data codeword perfect, every error-correction
  codeword garbage.

There was a property test written specifically to catch this class of bug — a divisibility
check on the codeword polynomial — and **it agreed with the bug**, because the test and the
encoder had the same author and therefore the same misunderstanding. A property derived
from the reasoning that produced the bug proves only that the reasoning is self-consistent.

Both are now pinned to a reference value and a decode round-trip, and both were verified by
putting the bugs back and watching the tests fail. That practice is now the rule for
anything hand-encoded in this repo.

**A third bug of the same family**: the error-correction level was hardcoded to `M` at
every call site, and a 261-byte token payment met a 216-byte ceiling. The encoder takes the
strongest level that fits now, because a link's length depends on the domain, the mint and
the memo, and nothing at the call site knows any of them.

---

## Correct parts, wrong whole

The first QR that scanned cleanly was **rejected by Phantom as invalid.**

Every component had been checked individually. The encoding matched the spec. The GET
response was well-formed. The icon returned 200. The transaction simulated against mainnet
with `err: null`. All of it true, and the result still did not work — because it used
Solana Pay's **transaction request** form, where a wallet fetches a transaction from a URL,
when what wallets overwhelmingly implement is the **transfer request** form:

```
solana:<recipient>?amount=0.25&spl-token=<mint>&reference=<pubkey>&label=…
```

There is no unit test for choosing the wrong half of a protocol, and verifying every piece
individually is not evidence that the system works. Both forms ship now: transfer requests
for anything a wallet will scan, transaction requests kept where the endpoint needs the
ability to **refuse** at fetch time.

The bot command takes flags rather than positions:

```
/pay 0.25 --to <recipient> --sender <wallet>
```

`--sender` originally checked nothing useful. It called `buildTransfer`, which does not read
the native balance, so an empty wallet came back clean. It reads the balance now and fails
at the terminal rather than on the customer's approval screen.

---

## Every code is artwork, and the artwork is evidence

Each payment QR is styled from a seed derived from the payment's `reference` — the pubkey
attached to the transfer that makes it findable on chain.

Because it is *derived* rather than stored, the picture is a fingerprint of one payment.
Two payments cannot render alike. The same payment always renders identically. And anyone
holding the reference can re-derive it and check.

```ts
const { png, svg, style } = pay.qr(url);
style.palette.name;    // 'jade/magenta' — the traits the receipt will carry
```

Three invariants keep this from costing a scan, and each is asserted rather than intended:
the matrix is never touched, the quiet zone stays empty, and contrast never varies.

**The third cannot be done with lightness bands**, which was the first attempt. Lightness is
not brightness — yellow at 38% is far brighter to a sensor than blue at the same number —
and a 400-seed sweep found an accent at **2.18:1** against the 3:1 a scanner needs. Contrast
is constructed now: every dark colour is measured against that receipt's paper and darkened
until it clears its target.

Telegram sends photos, not vectors, so the artwork is drawn straight into pixels rather than
rasterised by a headless browser — a rendering engine is an enormous dependency for one
picture. Two implementations of one geometry drift, so the tests threshold the rendered
pixels back into a matrix and compare it to the one that went in. **A code that binarises
wrongly still looks exactly like a QR to a person**, which is why "it looks right" proves
nothing.

**One of those tests was wrong before the renderer was.** It failed twelve modules — the
four corners of each rounded or circular finder — and those corners carry no data and are
never sampled. A decoder finds a code by the 1:1:3:1:1 run ratio through each finder's
centre, then transforms from the three centres. So the wrong criterion was replaced with the
real one, and then confirmed to bite: shrinking the finder core to 2x2 fails the ratio test
and sails through the matrix comparison.

---

## Receipts, and what a token can honestly prove

A settled payment can be minted as a receipt NFT of that same picture.

```ts
const settlement = await pay.settle(intent.id);
const { facts, image, metadata } = pay.receipt(settlement);

const uri = receiptUri('https://receipts.example.com', facts);
const { mint } = pay.receipt(settlement, { uri, payer: buyerAddress });
```

`receiptFacts` is fail-closed and refuses three things: a settlement that is
`probabilistic` rather than `final`, because the token outlives a transaction that can still
be dropped; one carrying mismatches, because final is not the same as *yours*; and one with
no signature to point at. **A receipt assembled from a claim rather than a settlement is a
forgery with good intentions.**

**The image is not on chain, and nothing here pretends otherwise.** Metaplex caps the
metadata `uri` at 200 bytes and the smallest receipt SVG is about 30KB — two orders of
magnitude, which no optimisation closes. So the arrangement is inverted: the *seed* goes on
chain, where it already is, and the image is a function of it.

```ts
verifyReceiptImage(facts, whateverTheHostServed);   // false if it was swapped
```

That argument had a gap when it was first written, found while building the agent tool for
it. Re-derivation answers *"is this image the one this reference generates"*. It does not
answer *"which reference does this token belong to"* — and the attribute naming the
reference lived only in the off-chain JSON, which is precisely the part a host can rewrite.
The claim was true and narrower than it read.

The on-chain `name` field holds 32 bytes, too few for `Receipt ` plus a 43-character base58
reference. The `uri` holds 200. So the reference goes in the URL, and the chain becomes
checkable end to end: the uri names the reference, the reference generates the image, and
the reference is an account key on the payment transaction that anyone can look up.

The mint is **immutable** and its supply is capped at one by an authority nobody holds. Both
are deliberate: this project ships a tool that warns holders about rewritable metadata, and
minting some would make that warning advice nobody follows.

### The one key

Solana requires a new account's own key to sign its creation. There is no way around it
without a custom on-chain program, so `buildReceiptMint` generates a throwaway mint keypair
and **returns it rather than using it**.

It is never funded. It controls nothing. It holds no authority once the master edition
exists, because `CreateMasterEditionV3` moves the mint authority to a PDA nobody has a key
for. The payer's wallet remains the fee payer, the token recipient, and the only signer
authorising anything of value — what the ephemeral key authorises is the existence of an
account the payer is already paying for.

That is the sole exception to "no signing, ever" in this codebase. It is narrow by
construction and it is stated here rather than buried in a changelog.

**The encoding was verified from outside rather than against itself**, which is the lesson
this release already paid for once. The metadata PDA derivation is pinned to the USDC
metadata account read off mainnet — the Token Metadata program owns it and its own bytes
name USDC as its mint. The full six-instruction transaction was simulated against mainnet:
`err: null`, with Metaplex logging `IX: Create Metadata Accounts v3` and
`V3 Create Master Edition`. 740 bytes against a 1232-byte limit.

---

## Pair to pair

The SDK and the agent are meant to be one system rather than two that resemble each other.
That claim is cheap to make and easy to break: both render QR codes, both derive a style,
and nothing stops them drifting apart a release at a time until a customer comparing the
code in a chat message against the one in a checkout page sees two different pictures.

The SDK's tests assert its output **byte for byte** against the agent's own renderers.

Neither side has to be told the style. The seed comes out of the link, which already has to
carry the reference because that is how a wallet attaches it — so `pay.qr()` stays pure, and
any two callers holding the same link agree by construction. Links without a reference fall
back to hashing the whole string.

**`receipt_art` is the eighteenth tool**, and `/receipt` the bot command for it. It answers
the question a holder cannot answer by eye — *is this picture the one this reference
generates?* — and it reads no chain and fetches nothing, because the whole point of deriving
art from the reference is that checking it needs no network.

The tests that matter there are the negative ones. A swapped image, a swapped reference and
a tampered SVG each have to come back false, because **a verifier that returns true for
everything converts "I have not checked" into "I have checked"** — which is worse than
having no verifier at all. Both the tool description and its output say that a mismatch is
**not proof of fraud**: it means the image is not evidence, which is a different and more
useful claim, and the description is the only thing steering how a model phrases that to
somebody.

Three existing catalogue guards refused to let that tool exist without a bot command and a
place in the MCP and conversation surfaces. They did wiring that would otherwise have been
left to memory.

---

## Two versions, still on purpose

`singularity-sdk` leaves 0.0.x for **v0.1.0**. It gained a payment surface, artwork and
receipts in this release, and a package with that much API answering to a patch number
misleads whoever reads the registry. It is still pre-1.0, which is the part that has not
changed.

The agent goes to **v0.2.0**. Sharing one number would make the SDK look ten releases more
settled than it is.

---

1,346 tests across both packages. 18 tools. MIT licensed. Still read-only, still holds no
keys — with the one documented exception above, which signs for the creation of an account
and nothing else.

**[github.com/DarkStarMatters/Singularity-Agent](https://github.com/DarkStarMatters/Singularity-Agent)**
