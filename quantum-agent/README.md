# quantum-agent

An MCP plugin for quantum agentic systems. It reads IBM Quantum backends, builds and
classifies circuits, estimates what a run would cost, and simulates locally. It is the
second plugin in the `singularity` marketplace, and it is meant to double as the Python
quantum sidecar that Tessarq's Q track plans ([Quantum-Chain `docs/ROADMAP-v0.2.md`, § Q](https://github.com/Civilisation-one/Quantum-Chain/blob/main/docs/ROADMAP-v0.2.md)).

**It never submits a job and never spends QPU time.** Submission will arrive as a
separate, explicitly gated tool. Until then that sentence is true of the whole server, and
`tests/test_server.py` pins the tool list so it stays true.

It lives beside Singularity rather than inside it for one reason: Singularity's promise
is that it holds no keys and moves nothing, and a quantum tool that eventually runs jobs
would break that promise the day it shipped.

## What it is for

The question it answers first is the one that is usually asked last: **what could a result
from this circuit ever prove?** On today's hardware nobody can cheaply and trustlessly prove
that a quantum device produced a result. So, following Tessarq, every job carries three
separate claims, each with its own ceiling:

| Claim | How it can be checked | Best label it can earn |
|---|---|---|
| The result is correct | only for circuits whose ideal output is computable (below) | `verified_implementation` |
| It ran on the QPU that was claimed | IBM's job record | `preliminary` |
| The hardware is quantum | proof-of-quantumness protocols (research) | `hypothetical` |

`classify_circuit` puts a circuit in one of four classes *before* it runs:

| Class | Why its output is checkable | Correctness ceiling |
|---|---|---|
| `deterministic` | exactly one ideal bitstring (Clifford at any width, or state vector) | `verified_implementation` |
| `clifford` | stabilizer simulation, at any width | `verified_implementation` |
| `small` | at most 12 active qubits: full state vector | `verified_implementation` |
| `attested` | not checkable; the provider's word only | `preliminary` |

Mirror circuits (`build_circuit` with `template: "mirror"`) are the workhorse: random
Clifford layers, their exact inverse, then a random X layer. They have one known ideal
outcome at any width, so a hardware run's success probability is checkable from its counts
alone, and a device stuck at |0⟩ cannot pass.

## Tools

| Tool | What it does | Touches |
|---|---|---|
| `backends` | IBM backends with status and queue (`source: "ibm"`), or bundled snapshots (`"fake"`) | IBM / local |
| `calibration` | median T1/T2, readout and 2q error, worst qubits, and a `sha3-256` calibration hash | IBM / local |
| `usage` | QPU usage for the instance, as IBM reports it | IBM |
| `job` | a job's status, backend, usage and counts per register | IBM |
| `build_circuit` | `bell`, `ghz`, `mirror` → OpenQASM 3 + commitment | local |
| `classify_circuit` | the class, the ideal outcome, and the three label ceilings | local |
| `estimate` | seeded transpile: depth, 2q count, layout, estimated success probability, lower bound on QPU seconds | IBM / local |
| `simulate` | Aer, ideal or noisy under a fake backend's recorded calibration | local |

Every answer carries a `source`: `ibm_quantum`, `fake_backend_snapshot` (with the date the
calibration was recorded, which says nothing about the device today), or `local`. Lists
and histograms carry `completeness`, as Singularity's do. A histogram cut to its top
outcomes says how many shots the cut removed. A failed read is a tool error with a `code`,
never an empty result.

## Commitments

Tessarq's planned `QuantumJob` carries a circuit commitment and a calibration hash, and
nothing on-chain fixes their byte format yet. Until it does, this is the definition
(`src/quantum_agent/commit.py`, with pinned vectors in `tests/test_thinline_commit.py`):

- **circuit:** SHA3-256 over the OpenQASM text exactly as sent, with only line endings
  normalised to LF. It is never a re-export, because a re-export changes with the qiskit
  version.
- **calibration:** SHA3-256 over canonical JSON (sorted keys, no whitespace, UTF-8, NaN
  refused) of every qubit's T1/T2/readout error and every gate's error and duration.

Both are spelled `sha3-256:<hex>`. Tessarq's `Hash32::from_hex` strips only `0x`, so strip
the prefix before putting one on-chain.

## Setup

Needs [uv](https://docs.astral.sh/uv/). Sync once before first use: the first sync
downloads qiskit and Aer, which takes longer than an MCP client waits for a server to start.

```bash
cd quantum-agent
uv sync
uv run pytest            # 42 tests; no network, no credentials
```

IBM credentials come from the environment the server runs in, never from a tool argument:

```bash
QISKIT_IBM_TOKEN=...          # IBM Quantum API key
QISKIT_IBM_INSTANCE=crn:...   # instance CRN
QISKIT_IBM_CHANNEL=ibm_quantum_platform   # the default
```

If no token is set, it falls back to an account saved with
`QiskitRuntimeService.save_account`. With neither, the IBM tools fail with
`ibm_credentials_missing`, and everything built on `fake_*` backends still works.

### As a Claude Code plugin

From the parent directory of the repo:

```bash
claude plugin marketplace add ./Singularity-Agent
claude plugin install quantum-agent@singularity
```

Or directly, as a plain MCP server:

```bash
claude mcp add quantum-agent -- uv run --quiet --directory /path/to/Singularity-Agent/quantum-agent quantum-agent-mcp
```

## Next

In order. See the plan in the repository's roadmap discussion:

1. **Verifiers.** Mirror success probability first, then Clifford support and small-circuit
   Hellinger fidelity. Each ships with JSON test vectors that Tessarq's Rust Q2 verifiers
   must reproduce.
2. **Gated submission.** `submit_job`: dry run by default, a hard cap on QPU seconds,
   optional Q-CTRL Fire Opal, and the first real mirror batch measured raw against Fire
   Opal.
3. **Onto the chain.** A ThinLine experiment record as an unsigned Tessarq payload, and
   `QuantumJobStake.isEligible` read through Singularity.
4. **Agentics.** Singularity's evidence-scored mesh with quantum tools as its moves, and
   budget-bounded variational loops.
