"""
The quantum-agent MCP server.

Every tool here reads, builds or computes locally. None submits a job, so none
spends QPU time. Submission will be a separate, explicitly gated tool; until it
exists, that sentence is true of the whole server, and `tests/test_server.py`
holds it to that by pinning the tool list.
"""

from __future__ import annotations

import functools
from typing import Any, Callable

from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from mcp.types import ToolAnnotations

from . import __version__, backends, circuits, jobs
from .classify import classify
from .envelope import LOCAL, QuantumAgentError, Source, exhaustive
from .estimate import estimate as estimate_on
from .simulate import simulate as simulate_on

INSTRUCTIONS = """\
quantum-agent reads IBM Quantum backends, builds and classifies circuits, and \
simulates them locally. It never submits jobs and never spends QPU time.

Start with `classify_circuit`: it says, before anything runs, the strongest \
evidence label a result from that circuit could ever earn. A circuit classed \
`attested` can never be checked from its counts, however it is run.

Backends named `fake_*` are recorded snapshots of real devices; every answer \
built on one carries the date it was recorded, and none describes the device \
today. IBM credentials come from the server's environment only.

Circuits travel as OpenQASM 3 text with a `sha3-256:` commitment to that text. \
Pass the text back unchanged to keep the commitment valid."""

server = MCPServer(
    "quantum-agent", version=__version__, instructions=INSTRUCTIONS
)

READ_ONLY = ToolAnnotations(readOnlyHint=True, destructiveHint=False, idempotentHint=True)
READ_ONLY_REMOTE = ToolAnnotations(
    readOnlyHint=True, destructiveHint=False, idempotentHint=True, openWorldHint=True
)


def structured(fn: Callable[..., dict[str, Any]]):
    """Turn a QuantumAgentError into an MCP tool error carrying its code, never into data."""

    @functools.wraps(fn)
    def wrapper(*args, **kwargs):
        try:
            return fn(*args, **kwargs)
        except QuantumAgentError as exc:
            raise ToolError(exc.to_json()) from exc

    return wrapper


def _with_source(data: dict[str, Any], source: Source) -> dict[str, Any]:
    return {**data, "source": source.to_dict()}


@server.tool(name="backends", annotations=READ_ONLY_REMOTE)
@structured
def backends_list(source: str = "ibm", min_qubits: int | None = None) -> dict[str, Any]:
    """List quantum backends. source='ibm' reads the backends your IBM Quantum instance can
    see, live, with status and queue depth (needs credentials). source='fake' lists the
    recorded device snapshots bundled with qiskit-ibm-runtime, which need nothing."""
    if source == "ibm":
        rows = backends.list_ibm(min_qubits)
        return _with_source(
            {
                "backends": rows,
                "completeness": exhaustive("Every backend visible to this IBM Quantum instance."),
            },
            Source("ibm_quantum", "backend list, read live"),
        )
    if source == "fake":
        rows = backends.list_fake(min_qubits)
        return _with_source(
            {
                "backends": rows,
                "completeness": exhaustive(
                    "Every fake backend in the installed qiskit-ibm-runtime. Each is a snapshot "
                    "dated by `recorded`."
                ),
            },
            Source("fake_backend_snapshot", "bundled with qiskit-ibm-runtime"),
        )
    raise QuantumAgentError("unknown_source", f"source must be 'ibm' or 'fake'; got {source!r}.")


@server.tool(annotations=READ_ONLY_REMOTE)
@structured
def calibration(backend: str, qubits: list[int] | None = None) -> dict[str, Any]:
    """A backend's calibration: median T1/T2, readout and two-qubit gate error, the worst
    readout qubits, and a sha3-256 calibration hash over the complete snapshot. Pass
    `qubits` for per-qubit detail on those qubits."""
    b, src = backends.get_backend(backend)
    return _with_source(backends.calibration(b, qubits), src)


@server.tool(annotations=READ_ONLY_REMOTE)
@structured
def usage() -> dict[str, Any]:
    """QPU usage for the active IBM Quantum instance, as IBM reports it."""
    return _with_source(jobs.usage(), Source("ibm_quantum", "instance usage, read live"))


@server.tool(annotations=READ_ONLY_REMOTE)
@structured
def job(job_id: str) -> dict[str, Any]:
    """Read an IBM Quantum job: status, backend, usage, and counts per register if it has
    finished. Reading only; it does not cancel or resubmit anything."""
    return _with_source(jobs.job(job_id), Source("ibm_quantum", f"job {job_id}, read live"))


@server.tool(annotations=READ_ONLY)
@structured
def build_circuit(
    template: str,
    qubits: int | None = None,
    layers: int | None = None,
    seed: int | None = None,
) -> dict[str, Any]:
    """Build a circuit from a template, as OpenQASM 3 plus its sha3-256 commitment.
    Templates: 'bell'; 'ghz' (qubits); 'mirror' (qubits, layers, seed), a circuit whose one
    ideal bitstring is known, so a hardware run's success probability is checkable from
    its counts at any width. The same arguments always produce the same text and hash."""
    qc, meta = circuits.build(template, qubits, layers, seed)
    return _with_source(circuits.emit(qc, meta), LOCAL)


@server.tool(annotations=READ_ONLY)
@structured
def classify_circuit(qasm: str) -> dict[str, Any]:
    """Before running a circuit, say what its result could ever prove: its class
    (deterministic, clifford, small, attested), the ideal outcome when there is exactly
    one, and the ThinLine label ceiling for each of Tessarq's three claims."""
    from .commit import circuit_commitment

    qc = circuits.load_qasm(qasm)
    return _with_source({"commitment": circuit_commitment(qasm), **classify(qc)}, LOCAL)


@server.tool(annotations=READ_ONLY_REMOTE)
@structured
def estimate(qasm: str, backend: str, shots: int = 4000, optimization_level: int = 2) -> dict[str, Any]:
    """Transpile a circuit for a backend, locally and with a fixed seed, and report depth,
    two-qubit gate count, the physical qubits chosen, an estimated success probability
    from calibration, and a lower bound on QPU seconds. Spends nothing."""
    qc = circuits.load_qasm(qasm)
    b, src = backends.get_backend(backend)
    return _with_source(estimate_on(qc, b, shots, optimization_level), src)


@server.tool(annotations=READ_ONLY)
@structured
def simulate(qasm: str, shots: int = 1000, seed: int = 0, noise_backend: str | None = None) -> dict[str, Any]:
    """Run a circuit on this machine with Aer: ideal by default, or noisy under a fake
    backend's recorded calibration (noise_backend='fake_fez', ...). Counts come back cut to
    the most frequent outcomes, with completeness saying so."""
    qc = circuits.load_qasm(qasm)
    if noise_backend is None:
        return _with_source(simulate_on(qc, shots, seed), LOCAL)
    if not backends.is_fake(noise_backend):
        raise QuantumAgentError(
            "noise_backend_not_fake",
            "Noisy simulation takes a fake backend, whose snapshot is fixed and reproducible.",
            "Use a fake_* name, e.g. fake_fez; list them with backends(source='fake').",
        )
    b, src = backends.get_backend(noise_backend)
    return _with_source(simulate_on(qc, shots, seed, noise_backend=b), src)


def main() -> None:
    server.run()


if __name__ == "__main__":
    main()
