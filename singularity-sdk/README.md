# singularity-sdk

**v0.0.1** — build blockchain applications on [Singularity Agent](../README.md).

The agent is a read-only CLI and MCP plugin: one normalized surface over **EVM**,
**Solana**, **Bitcoin/UTXO** and **Cosmos**, for a human at a terminal or a model over
MCP. This SDK is the third caller — an application — and it adds the four things an
application needs that a command line does not.

```bash
npm install singularity-sdk singularity-agent
```

```ts
import { createSingularity } from 'singularity-sdk';

const sdk = createSingularity({ chain: 'ethereum' });

const balance = await sdk.balance({ address: 'vitalik.eth', includeTokens: true });

console.log(balance.native.amount.formatted);
console.log(balance.tokenCompleteness.kind);   // 'curated' — read this before the list
```

Or start from a project that already runs:

```bash
npx singularity-sdk new my-app --template reader
cd my-app && npm install && npm start
```

---

## What it adds

### 1. A configured client

Defaults set once instead of on every call, a cache that only holds what is safe to
hold, and retry on the failures worth another attempt. Nothing is reimplemented — a
read through this client and a read through `singularity balance` go down the same code
path and carry the same completeness envelope.

```ts
const sdk = createSingularity({
  chain: 'ethereum',
  budget: { maxItems: 8 },            // honest `truncated` envelopes, not silent cuts
  portfolioChains: ['ethereum', 'base', 'arbitrum'],
  rpc: { ethereum: process.env.MY_ENDPOINT! },
  cache: { current: 5_000 },          // default is 0 — see below
  retry: { attempts: 3 },
});
```

**The cache rule** is not "cache reads". It is: *a cached answer may only be wrong in
the direction that is already safe.*

| Read | TTL | Why |
|---|---|---|
| Pinned to a height (`atBlock`) | 5 min | Immutable once final. |
| Current state | **0 — off** | Stale the instant it returns. Opt in if your app can tolerate it. |
| Chain metadata, name resolution | 60s | Slow-moving. |
| `liveness`, `endpoints`, `verifyBurn` | **never, at any TTL** | See below. |

There is deliberately no option to cache a liveness probe. Its entire job is to say
whether something is responding *now*; a cached "yes" is indistinguishable from the
outage it exists to catch, and the option would be a bug with a config flag in front of
it. `verifyBurn` is excluded for the same shape of reason: it is the check standing
between a burn and whatever it entitles someone to, and a cached answer is a replay
window.

### 2. A custody seam the SDK never crosses

The agent's permanent non-goal is **no signing, ever**. An application that can only
read is not an application, so the seam moves rather than dissolving: this SDK defines
the *port* a write travels through and ships **no implementation of it**.

There is no keypair loader here, no wallet adapter, no `fromPrivateKey`, no secret read
from the environment. `test/custody.test.ts` scans the published source and fails if one
appears — that absence is the product, not a promise in a README.

```ts
interface Signer {
  families: readonly ChainFamily[];
  address(chain: ChainSpec): Promise<string>;
  sign(tx: UnsignedTx, chain: ChainSpec): Promise<SignedTx>;
  send?(tx: SignedTx, chain: ChainSpec): Promise<string>;   // optional
}
```

Keys stay where your application already keeps them — a browser wallet, a KMS, an HSM, a
hardware device, a signing service behind a human approval step. None of those want to
hand a secret to a library, and none of them have to.

`build` always works. `write` does not exist until you supply a signer, **and the type
system says so**:

```ts
const readOnly = createSingularity({ chain: 'ethereum' });

await readOnly.build.transfer({ to: 'vitalik.eth', amount: '0.1' });   // fine
await readOnly.write.transfer({ to: 'vitalik.eth', amount: '0.1' });
//               ~~~~~~~~
// Property 'transfer' does not exist on type 'SignerRequired'.

const app = createSingularity({ chain: 'ethereum', signer: myWallet });
await app.write.transfer({ to: 'vitalik.eth', amount: '0.1' });        // callable
```

Three checks stand between a built payload and a broadcast, and each catches a failure
that is otherwise silent:

1. **Family**, before anything is built — an EVM-only signer asked for a Solana burn
   fails on the first line naming both families, not inside an encoder.
2. **Chain**, after signing — the signer's `SignedTx.chain` must match what was built.
   A signer that quietly signs for mainnet what was built for a testnet produces a
   perfectly valid transaction, and nothing else would catch it.
3. **Broadcast capability** — a signer with no `send` returns `broadcast: false` rather
   than a receipt with no hash that reads like success.

The SDK's own network layer stays read-only throughout. It never puts bytes on a chain;
`Signer.send` is your code talking to your endpoint.

### 3. Watching

Roadmap 4.3 has said "watch mode" since v0.0.3. The honest version is less impressive
than the word suggests, and saying so matters: **these are polling loops.** No push, no
websocket, no reorg feed. A poll can miss a value that changed and changed back, and
reports *the state at the times it asked* — a weaker claim than "everything that
happened".

The loop itself lives in the agent, at `src/core/watch.ts`, because `singularity watch`
needs the same one and the dependency only runs one way. What is in this package is the
part that differs per watch: *what counts as a change*. That is the decision worth making
carefully, and it is different each time — a block number is the whole answer for a chain
tip and irrelevant for a balance, where a re-worded completeness note must not read as
money moving. `balanceIdentity` is exported for anyone writing their own loop.

```ts
const watch = sdk.watch.balance(
  { address: 'vitalik.eth' },
  ({ value, previous }) => {
    if (!previous) return;                    // first delivery is not a change
    console.log(`${previous.native.amount.formatted} → ${value.native.amount.formatted}`);
  },
  { intervalMs: 15_000, stopAfterErrors: 10 },
);

watch.stop();
```

What the loops do guarantee: no overlapping ticks, exponential backoff on failure,
errors delivered to `onError` rather than swallowed, and handlers that fire on change
rather than on every tick. `watch.transaction` stops on its own once your confirmation
depth is met.

### 4. An agent surface

The same catalogue the MCP plugin serves, derived into Anthropic, OpenAI-style and MCP
shapes from one source. Add a tool to the agent and it appears in all of them; no copy
is left saying the old thing.

```ts
import { createExecutor } from 'singularity-sdk';

const agent = createExecutor({
  selection: { only: ['balance', 'portfolio', 'resolve', 'transaction'] },

  before(name, input) {
    if (name === 'history' && Number(input.limit) > 50) return { ...input, limit: 50 };
    if (isBlocked(input.address)) throw new Error('Not available for this address.');
  },

  after: (result) => audit.log(result),
});

const tools = agent.anthropic();              // or agent.functions(), or mcpTools()
const result = await agent.run(name, input);  // never throws; failures are values
```

`before` runs after the model chose a tool and before the tool runs — the only moment
where both the choice and its arguments are known, and where an allow-list, a rate limit
or a confirmation step belongs. A tool excluded by `selection` is **refused by name**,
not merely omitted: a model can name a tool it was never offered.

Arguments are validated against the tool's schema before any operation sees them,
because the caller here is a model improvising JSON. Failures come back as
`{ isError: true, hint }` rather than thrown, with the agent's own hints intact — they
are written for exactly that reader.

---

### 5. Payments that leave a receipt

Every QR this SDK renders is artwork derived from the payment's `reference` — the pubkey
attached to the transfer that makes it findable on chain. Because it is *derived* rather
than stored, the picture is a fingerprint of one payment: two payments can never render
alike, the same payment always renders identically, and anyone holding the reference can
re-derive it and check.

```ts
const { url, intent } = await pay.createIntent({ to, amount: '0.25' });
const { png, svg, dataUrl, style } = pay.qr(url);

style.palette.name;   // 'jade/magenta' — the traits the receipt NFT will carry
```

The seed comes out of the link, which already carries the reference because that is how a
wallet attaches it. So `pay.qr()` stays pure — no store lookup, no extra argument — and
the agent's Telegram bot renders the **same bytes** from the same link without either side
having to agree on anything. That is asserted byte-for-byte in the tests, not hoped for.

Pass `{ plain: true }` for an unstyled code.

Once a payment settles, it can become a receipt NFT of that same picture:

```ts
const settlement = await pay.settle(intent.id);

// Step one: facts, artwork and metadata. Throws unless the payment is
// finalized AND matches the claim — a token asserting a reversible payment
// outlives the transaction it describes.
const { facts, image, metadata } = pay.receipt(settlement);

// Host the metadata at <base>/<reference>.json, then step two:
const uri = receiptUri('https://receipts.example.com', facts);
const { mint } = pay.receipt(settlement, { uri, payer: buyerAddress });

mint.transaction;    // unsigned, six instructions, atomic
mint.mintKeypair;    // sign with it, send, discard — see below
```

**The image is not on chain, and nothing here pretends otherwise.** Metaplex caps the
`uri` field at 200 bytes; the smallest receipt SVG is ~30KB. So the *seed* goes on chain
instead — the reference is an account key on the payment transaction, and `receiptUri`
puts it in the URL so it is recorded in the mint's own metadata account. The image is a
function of it. A host that swaps the picture cannot make the swap verify:

```ts
verifyReceiptImage(facts, whateverTheHostServed);   // false
```

That check is also an agent tool (`receipt_art`) and a bot command (`/receipt`), so a
holder can ask the question without writing any code. A `false` means the image is not
*evidence* — not that the payment is bad.

Two deliberate constraints on the mint: metadata is **immutable** (this project ships a
tool that warns holders about rewritable metadata; minting some would make that warning
advice nobody follows), and `maxSupply` is zero, so the mint authority moves to a PDA
nobody holds a key for.

> **The one key.** Solana requires a new account's own key to sign its creation, so
> `buildReceiptMint` generates a throwaway mint keypair and hands it back rather than
> using it. It is never funded, controls nothing, and holds no authority once the master
> edition exists. The payer's wallet remains the fee payer, the recipient, and the only
> signer authorising anything of value. This is the sole exception to the custody seam
> above, and it is narrow by construction.

---

## Completeness, which you have to handle

Every list-shaped result carries an envelope, and it is the difference between two
answers that are the same empty array:

```ts
const { tokens, tokenCompleteness } = await sdk.balance({ address, includeTokens: true });

switch (tokenCompleteness.kind) {
  case 'exhaustive': break;   // the only kind where `tokens: []` means "holds nothing"
  case 'curated':    break;   // a subset was checked — absence proves nothing
  case 'truncated':  break;   // more existed; `.shown` and `.omitted` say how much
  case 'failed':     break;   // nothing was checked — not the same as nothing found
}
```

On Ethereum this is almost never `exhaustive`, because no JSON-RPC method can enumerate
an account's tokens. An application that renders an empty list as "no tokens" is
confidently wrong on the chain most people will try first.

---

## Templates

```bash
npx singularity-sdk templates
npx singularity-sdk new <dir> --template <id>
```

| Template | What it is |
|---|---|
| `reader` | A read-only script: balances, portfolio, completeness handling. No keys. |
| `monitor` | A liveness and balance watcher, with backoff and clean shutdown. |
| `agent` | A tool-use loop with a policy hook, and a signer stub that throws. |

The `agent` template's signer is a stub *on purpose*. A working keypair signer sitting
in a template, one uncomment from active, is the most reliable way to get a private key
committed to a public repository. The type is right and the behaviour is wrong, which is
the safer way to be incomplete.

---

## Development

This package is a workspace of the [Singularity Agent](../README.md) repository, and
takes the agent as a **peer** dependency rather than bundling it. That is a real
constraint, not a packaging preference: the agent's chain registry is module state, and
two copies in one tree would mean the SDK configuring a registry the operations it calls
are not reading from — endpoint overrides that silently do nothing.

```bash
npm install                        # from the repository root
npm run build                      # the agent, which the SDK compiles against
npm run typecheck -w singularity-sdk
npm test                           # one suite, both packages
```

Every change needs a test. The most valuable contributions here, in order:

1. **A write that reaches a network without going through `Signer.send`.** That is the
   one invariant this package exists to hold.
2. **A cached answer that should not have been cached.** The table above is the claim;
   a counterexample outranks everything below it.
3. **A gate tested only on what it rejects.** The custody scanner in
   `test/custody.test.ts` plants each pattern it claims to catch, because this
   repository has shipped a filter that passed 41 tests while dropping three quarters of
   what it was meant to let through.

---

MIT · [github.com/DarkStarMatters/Singularity-Agent](https://github.com/DarkStarMatters/Singularity-Agent)
