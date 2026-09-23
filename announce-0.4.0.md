# Singularity Agent v0.4.0

**Twenty tools, and no way to say which of them a question needed. The twenty-first is the
one that decides.**

```bash
npm install singularity-agent
```

`mesh` takes a subject and a stated objective, works out which calls could answer it, runs
them in a searched order, and reports three things: the facts, the path that proved them,
and an explicit list of what it could not prove and why. Still read-only in every sense
that has ever mattered here — every move in a mesh run is a read, and the move table is a
closed list.

`singularity-sdk` stays at **v0.2.0**. It reads its tools from the agent's catalogue, so it
gets `mesh` without a change of its own, and its peer range now asks for v0.4.0.

---

## Every call correct, the sequence wrong

A model asked whether a token is safe to buy issues four calls in whatever order occurred
to it, re-reads a mint it already read, stops when the first few answers look like enough,
and afterwards cannot say which parts of its summary were established and which were
simply absent.

Every individual call in that sequence is correct. The sequence is not, and nothing was
watching it, because a tool catalogue has no opinion about the order its tools are used in.

So the order becomes a thing with a definition. Six objectives — `identify`, `holdings`,
`activity`, `settlement`, `safety`, `liveness` — each declare the facts that count as an
answer. The search runs the cheapest moves that could prove the ones still missing, several
at a time, and stops when they are all proved or the call budget is spent. A move that
cannot contribute is never enumerated.

```bash
singularity mesh safety <mint> -c solana
singularity mesh safety <mint> -c solana --plan    # the order and the cost, calling nothing
```

---

## The reward is arithmetic

The frontier is A* over evidence: `g` is round trips spent, `h` is facts still missing.
Each wave expands the applicable moves, evaluates the best few concurrently, and elects the
ones that paid. A wave that elects nothing is a backtrack; two in a row stop the run.

The reasoning-model literature scores each step with a second model trained to judge
reasoning. This repository already has something better suited: every tool reports how good
its own answer is. `completeness` says exhaustive, curated, truncated or failed; an error is
a code and a hint. The step reward is computed from those, and **never from how plausible a
step looked**. Two runs against the same chain state produce the same path and the same
rewards, and every step records its tool and exact arguments, so any one can be re-run by
hand.

The rule worth arguing with: a step that *succeeded and proved nothing new* scores zero and
is discarded by the same rule as one that errored. That is the failure that looks like
progress in every transcript.

---

## `unproven` is the deliverable

`verdict` is about the evidence, never about the subject. `answered` means every fact the
objective asked for was proved — not that the token is fine.

Everything short of that is named: a tool that does not apply on this family, a
prerequisite never proved, an endpoint that refused, a budget that ran out. Where the source
said why it could not answer, that sentence *is* the reason — an EVM `history` call with no
indexer key says what is missing and how to supply it, and a mesh that flattened that into
"not established" would turn a fixable gap into a shrug.

The CLI exits non-zero on anything short of `answered`, so a script cannot read a partial
picture as a complete one.

`mesh` is registered everywhere the other twenty are: the stdio MCP server, the hosted HTTP
one, Grok's function calling, the elizaOS plugin, the Telegram bot and the CLI.

---

## A picture of the run that cannot flatter it

A mesh run has a shape — waves, branches that paid, branches that were cut, facts that were
never proved. `/nft #1 "series name"` in Telegram draws the run you just read, and
`singularity mesh … --art run.png` does the same from a terminal.

The picture obeys the receipt art's rule: it is seeded from a canonical digest of the whole
run, so anyone holding the run can re-derive the image and check it. The symmetry is how many
facts the objective asked for. Each branch is one call, its length what the call earned. A
failed call is drawn severed; a call that answered and proved nothing ends in an open ring.
The facts never proved are dashed branches ending in nothing — a render that left them out
would be a picture of a different, better run.

The field behind it is a Julia set with |c| mapped from σ across the modulus where a Julia
set stops having an interior. A run that earned its calls renders as one connected body; a
run that thrashed renders as dust. **A bad search cannot produce a prettier picture than a
good one.**

Two seeds: the digest alone drives all geometry, and the digest with series and edition
drives palette and ornament. `#1` and `#2` of one run are the same structure in different
colours, and neither can be mistaken for a different run.

Artwork goes out as a Telegram *document*, not a photo, because a photo is re-encoded and
this image's claim is that it re-renders byte for byte. Nothing here mints: it produces the
image, the traits and Metaplex-shaped metadata, and hosting that is the application's
decision.

---

## Everything documented, and held to it

The README listed seventeen of twenty-one tools and eleven of thirty-three bot commands.
Nothing failed, because the only table anything checked was the website's. It now carries
every tool, every CLI command and subcommand, every bot command and alias, every npm script,
binary, SDK command and HTTP route — and tests hold each table row for row against the code.

Enumerating them found a real bug: `/invoice` was declared as an alias by both `/pay` and
`/checkpay`, and the later registration silently won. A test now asserts every name resolves
to exactly the command that claims it.

The version is held the same way, including the two places that name it in prose rather than
in a manifest — both of which went stale at this release before anything noticed.

---

21 tools. 32 chains. MIT licensed. Still read-only, still holds no keys.

**[github.com/DarkStarMatters/Singularity-Agent](https://github.com/DarkStarMatters/Singularity-Agent)**
