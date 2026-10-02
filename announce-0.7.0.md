# Singularity Agent v0.7.0

**State over time: when a chain stopped, whether its failover is still real, and what an
address held before today, with the gaps left as gaps.**

```bash
npm install singularity-agent
```

Until now every answer Singularity gave was about the moment you asked. It could tell
you whether a chain was live. It could not tell you when it stopped being live, whether
the endpoints configured for it still answered, or what an address held a month ago,
because nothing kept anything between calls. This release changes that, and the first
thing it found was a defect in the last one.

`singularity-sdk` stays at **v0.2.0**. Its peer range now asks for v0.7.0.

---

## v0.6.0 shipped with failover it did not have

The first history run showed **Ethereum answering from one endpoint of three**, and
Polygon and Sepolia from one of two. That is the state v0.6.0 went out in. Every chain
still read correctly, so nothing looked wrong; one more outage would have taken each of
them down with no fallback.

The dead endpoints had decayed in different ways. One answered 525, one started requiring
an API key and reported that as an error inside an HTTP 200, one answered 401 and one 404.
Each was replaced by a provider that answered with the right chain id and a current head.

The config test only counted entries, so it could not see this. A test now holds it
instead: `npm run snapshot:endpoints` records which endpoints served current state, and
`test/endpoint-snapshot.test.ts` fails if any mainnet configured with failover has fewer
than two that did. The snapshot must be taken for the version being released, so it
cannot go stale between releases.

---

## Liveness, kept

```bash
singularity doctor --record        # append one sample per chain
singularity doctor --history 7     # read the last week back
```

`--history` says when each chain stopped being live, as the interval it happened in
rather than a guessed instant. It gives every endpoint a verdict: `unproven`, `dead`,
`silent`, `load-bearing`, `lagging`, `flaky` or `healthy`. It also says, per chain,
whether the configured list still has the failover it claims.

Nothing records unless you pass `--record`. The store is a port with an in-memory
implementation and a JSON-lines file one, so an application that wants the history in its
own database plugs that in instead. A read-only client should not grow a data directory
behind its user's back.

---

## `balance_series`: a balance over time, without the invented parts

```bash
singularity series vitalik.eth -c ethereum --from=-2000000
```

The native balance at up to 32 evenly spaced past blocks, each one dated by its own block.
It is the twenty-third tool, and `/series` in the Telegram bot.

A series of readings looks more continuous than it is, so the tool works against that
at every step:

- **A height the endpoint no longer keeps is a labelled hole.** It is never shown as zero
  and never filled in from its neighbour.
- **A change of zero means the same balance at both readings.** It does not mean nothing
  happened in between, and the tool's description says so.
- **The result is never called complete.** It is `curated` when every height was read,
  `truncated` with the count when some were not, and `failed` when none were.
- **The CLI prints a table, not a chart,** because a chart draws the line between points,
  and the line is the part nobody knows.

Against Ethereum, five readings over two million blocks were all served at their exact
heights. Against Cosmos Hub's public endpoints, three of four came back as labelled holes,
which is the case this was built for. Solana cannot read past state at all, and refuses
the whole series once, with the reason.

Token balances over time are not in this release. The token scan drops zero balances, so
a series built on it could not tell "held none" from "not read".

---

23 tools. 33 chains. 35 bot commands. MIT licensed. Still read-only, still holds no keys.

**[github.com/DarkStarMatters/Singularity-Agent](https://github.com/DarkStarMatters/Singularity-Agent)**
