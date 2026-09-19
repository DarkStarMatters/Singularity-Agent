# Singularity Agent v0.1.0 — and `singularity-sdk` v0.0.1

**The read-only blockchain surface now has an SDK, so you can build applications on it —
without the SDK ever holding a key.**

Singularity puts one normalized surface over EVM, Solana, Bitcoin and Cosmos, for a human
at a terminal and for a model over MCP. Until now those were the only two callers, and
both of them ask one question and read one answer.

An application is a different thing. It runs for weeks, asks the same question hundreds of
times an hour, and sooner or later has to write. `singularity-sdk` is that third caller.

```bash
npm install singularity-sdk singularity-agent
# or start from a project that already runs:
npx singularity-sdk new my-app --template reader
```

---

## The part we thought hardest about: it still cannot sign

"No signing, ever" has been a permanent non-goal here, not a phase. Read-only is what
makes broad autonomy safe to grant — the worst a read-only tool can do is be wrong, and
being wrong is recoverable.

That invites an obvious objection, and it deserves a real answer rather than a rule
repeated louder: **an application that can only read is not an application.**

So the seam moved instead of dissolving. The SDK defines the *port* a write travels
through and ships **no implementation of it**:

```ts
interface Signer {
  families: readonly ChainFamily[];
  address(chain: ChainSpec): Promise<string>;
  sign(tx: UnsignedTx, chain: ChainSpec): Promise<SignedTx>;
  send?(tx: SignedTx, chain: ChainSpec): Promise<string>;   // optional
}
```

There is no keypair loader in that package. No wallet adapter, no `fromPrivateKey`, no
secret read from the environment. Your keys stay in the browser wallet, KMS, hardware
device or approval queue that already holds them — none of which wanted to hand a secret
to a library, and none of which have to.

The SDK's own network layer stays read-only throughout. It never puts bytes on a chain.
Broadcasting, where it happens at all, happens inside your `send`, against your endpoint.

**Two mechanisms hold that, because a guarantee in a comment is one this project has
already watched get violated three times by code that type-checks.**

First, a type. `write` does not exist until you supply a signer:

```ts
const sdk = createSingularity({ chain: 'ethereum' });

await sdk.build.transfer({ to: 'vitalik.eth', amount: '0.1' });   // fine — building is a read
await sdk.write.transfer({ to: 'vitalik.eth', amount: '0.1' });
//               ~~~~~~~~
// Property 'transfer' does not exist on type 'SignerRequired'.
```

Second, a test that reads the package's own source and fails if any of eleven signing or
key-handling patterns appears in it — and **plants each one to confirm the scanner catches
it**, rather than passing on a clean tree and proving only that it ran. That distinction is
not pedantry: this repo once shipped a filter that dropped 18 of 24 genuine questions while
passing all 41 of its tests, because every test asked whether it rejected spam and none
asked whether it let a real question through.

Three checks then stand between a built payload and a broadcast, each for a failure that is
otherwise silent:

- **Family**, before anything is built — an EVM-only signer asked for a Solana burn fails
  on the first line naming both, not somewhere inside an encoder.
- **Chain**, after signing — a signer returning a mainnet signature for a testnet payload
  produces a *perfectly valid transaction*, and nothing else in the stack would notice.
- **Broadcast capability** — a signer with no `send` returns `broadcast: false` rather than
  a receipt with no hash that an application would read as success and not retry.

---

## `watch` — finally, and under its real name

Watch mode has been on the roadmap since v0.0.3. It ships now on both surfaces, and the
reason it took this long is visible in what it turned out to be: **polling loops.**

There is no push here. No websocket, no reorg feed — four families offer four incompatible
subscription mechanisms and most public endpoints expose none of them. Saying so matters,
because the gap between "subscribed" and "asked every twelve seconds" is exactly where a
caller draws a wrong conclusion. A value that changed and changed back between two ticks is
a value this never saw.

```bash
singularity watch balance vitalik.eth -c ethereum
singularity watch tip -c solana -i 2
singularity watch tx <hash> -c ethereum --confirmations 12   # stops when it gets there
singularity watch liveness -c ethereum -c base --json
```

```ts
sdk.watch.balance({ address: 'vitalik.eth' }, ({ value, previous }) => {
  if (!previous) return;            // the first reading is not a change
  notify(previous.native.amount.formatted, value.native.amount.formatted);
}, { intervalMs: 15_000 });
```

What the loops *do* promise is narrower and testable: no overlapping ticks, exponential
backoff on failure, errors delivered rather than swallowed, and a first delivery that is
explicitly not a change — `previous` is absent, which is the flag that stops a balance
alert firing on startup for every address it watches. A reorg is reported rather than
smoothed over.

Under `--json`, `watch` emits **newline-delimited** compact JSON — one object per change —
unlike every other command, which indents for a human. A watch is a stream, and `jq`, a log
shipper and `grep` all want one record per line.

**One bug worth telling you about**, because it says something about how this project
tests. `pollLoop` unrefs its timer — correct for a library, since a script that starts a
watch and finishes its work should be allowed to exit. On the CLI the watch *is* the work,
so with nothing keeping the event loop open, Node exited after the first tick: one line of
output, exit code 0, and a command that looked like it had worked. No unit test could have
caught it — the loop was behaving exactly as designed. It is a property of the process, so
it is now tested as one, with the real binary run as a subprocess against a local fake
chain.

---

## Also in the SDK

**A cache with a rule rather than a TTL.** An application makes the same read far more
often than a CLI does, and caching that is both the obvious win and the obvious way to
start serving confidently wrong answers. The rule is: *a cached answer may only be wrong in
the direction that is already safe.*

| Read | TTL |
| --- | --- |
| Pinned to a height (`atBlock`) | 5 minutes — immutable once final |
| Current state | **0, off by default** — stale the instant it returns |
| Chain metadata, name resolution | 60s |
| `liveness`, `endpoints`, `verifyBurn` | **never, at any TTL** |

There is deliberately no option to cache a liveness probe. Its whole job is to say whether
something is responding *now*, so a cached "yes" is indistinguishable from the outage it
exists to catch — the option would be a bug with a config flag in front of it. `verifyBurn`
is excluded for the same shape of reason: it is the check standing between a burn and
whatever it entitles someone to, and a cached answer is a replay window.

**One catalogue, four shapes.** The sixteen tools were already defined once, with schema,
description and implementation attached. What was missing was everything outside MCP: an
application that wanted to *be* an agent had to transcribe them by hand, and a transcribed
schema drifts on the first change nobody propagated. The SDK derives Anthropic,
OpenAI-style and MCP shapes from that one source, validates arguments before any operation
sees them — the caller there is a model improvising JSON, and nothing on that path was
validating — and puts a policy hook in front:

```ts
const agent = createExecutor({
  selection: { only: ['balance', 'portfolio', 'resolve'] },
  before(name, input) {
    if (isBlocked(input.address)) throw new Error('Not available for this address.');
  },
});
```

A tool excluded by `selection` is **refused by name**, not merely omitted from the list,
because a model can name a tool it was never offered.

**A scaffolder**, with three templates that all run on the first try:

```bash
npx singularity-sdk new my-app --template reader|monitor|agent
```

The `agent` template's signer is a stub that *throws*. That is deliberate: a working
keypair signer sitting in a template, one uncomment from active, is the most reliable way
to get a private key committed to a public repository. The type is right and the behaviour
is wrong, which is the safer way to be incomplete.

---

## In the agent itself

`singularity-agent` goes to **v0.1.0**, and beyond `watch` the change is an export surface
that was quietly incomplete. `Completeness`, `ResponseBudget`, `Finality` and the liveness
types lived one directory below the export map, so a library consumer received a
completeness envelope on every list-shaped result and had no way to name its type without
reaching past `exports` into `dist/`.

**A caveat you cannot type is one you end up not handling**, and that is the exact failure
this project has now shipped three times. They are exported.

Two versions on purpose: the agent has nine releases behind it and the SDK has none.
Sharing a number would make the SDK look nine releases more settled than it is.

---

1,051 tests across both packages. MIT licensed. Still read-only, still holds no keys.

**[github.com/DarkStarMatters/Singularity-Agent](https://github.com/DarkStarMatters/Singularity-Agent)**
