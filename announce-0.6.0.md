# Singularity Agent v0.6.0

**A fifth chain family, a server that starts before Claude Code gives up on it, and two
plugins kept outside so the first one can stay read-only.**

```bash
npm install singularity-agent
```

Singularity holds no keys and moves nothing. Two things built this fortnight could not
make that promise: a quantum tool that will one day spend QPU time, and a prover link
that runs a compiler and holds HMAC keys. So they ship as the second and third plugins in
the same marketplace, each with its own version, and the agent itself stays exactly as
read-only as it was.

`singularity-sdk` stays at **v0.2.0**. Its peer range now asks for v0.6.0.

---

## Tessarq, through a node you run

Tessarq is a proof-of-stake chain with post-quantum (ML-DSA-65) signatures and its own
REST RPC. It has no public endpoint at all, so it is the first chain here whose endpoint
you supply:

```bash
export SINGULARITY_RPC_TESSARQ=http://127.0.0.1:8650
singularity balance <address> --chain tessarq
```

Until you set that, sweeps leave Tessarq out rather than tell you a node you never ran
is down. Every response shape was checked against a four-validator testnet, not read off
the Rust types, and the testnet found three things the types did not say:

- **Balances past 2^53, as bare JSON integers.** `JSON.parse` turns 49995998749999990
  into …992 and still prints …990, so the error survives inspection. They are now parsed
  without rounding.
- **The fee depends on the protocol version.** 10 base units under version 1. After the
  testnet voted itself to version 2, the predicted 5,217,774 matched the charge exactly.
- **Every network runs the same software,** so a balance from the wrong one looks fine.
  With `chainId` configured, the endpoint that actually answered is checked, failover
  included.

Transaction lookup by hash, history and past-block reads are refused with the reason,
because the RPC has none of them. A transfer comes back as the `tessarq transfer` command
to run, because no wallet signs ML-DSA-65.

---

## A server that starts in time

The plugin's MCP server had been timing out against Claude Code's 30-second connect
limit in five sessions of eight. It was never hung. Importing the catalogue read 1,363
files, 1,221 of them from viem and ox. The plugin now runs a single-file esbuild bundle:
0.35 s warm, against 2.7 s. A test holds that the bundle left nothing external and still
serves every tool over a real stdio process.

---

## `quantum-agent` — what a circuit could ever prove

On today's hardware nobody can cheaply prove that a quantum device produced a result. So
`quantum-agent` asks first what a result could prove, before anything runs.
`classify_circuit` puts a circuit in one of four classes (deterministic, Clifford, small
or attested), and each class has a ceiling on the label its result can earn.
`verify_result` then scores a run's counts by the method that class allows. A threshold
gives an integer verdict with no rounding first.

It reads IBM Quantum backends, calibration and jobs, builds mirror circuits with a
SHA3-256 commitment, estimates cost and simulates with Aer. It **never submits a job**,
and its server test pins the tool list so that stays true.

```bash
cd quantum-agent && uv sync
claude plugin install quantum-agent@singularity
```

---

## `singularity-lean-agent` — proved means the kernel said so

A link to [lean-worker](https://github.com/meta-introspector/lean-worker)'s certified
prover protocol. Its server and client are ported line for line, over a byte-exact wire
format whose test vectors a Lean file kernel-checks. A client accepts a certificate only
if the tag verifies, every field names this call, and the kernel accepted the proof with
no `sorryAx` among its axioms.

Building lean-worker to link against it found a broken build at the pinned commit. Once
staged into the layout its imports expect, 19 modules and 178 theorems hold, and none of
its 45 plugin contexts compile. The plugin's README records all of it, and
`lean_worker_build` reruns the check whenever upstream moves.

```bash
npm run build -w singularity-lean-agent
claude plugin install singularity-lean-agent@singularity
```

---

## Listed for sale

Five tools now carry prices, schemas and a payout wallet for the PrivateDAO agent
exchange: `mint_audit` 0.02, `inspect_exit` 0.03, `inspect_payment` 0.02, `prove_payment`
0.03 and `mesh` 0.08 USDC. `singularity exchange listings` shows them. They go live when
the exchange issues the owner token that publishing needs.

---

22 tools. 33 chains. Three plugins. MIT licensed. The agent is still read-only and still
holds no keys.

**[github.com/DarkStarMatters/Singularity-Agent](https://github.com/DarkStarMatters/Singularity-Agent)**
