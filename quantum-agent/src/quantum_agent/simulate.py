"""
Run a circuit on this machine before anyone pays to run it on a QPU.

Two modes: ideal (no noise), and noisy under a fake backend's recorded
calibration. The noisy mode is a model built from that calibration, so it
inherits the snapshot's date and none of a real device's crosstalk or drift.
Its purpose is to catch a circuit that cannot succeed at all, not to predict
the counts a device returns.

Seeds are fixed and reported, so a simulation is reproducible from its output.
"""

from __future__ import annotations

from typing import Any

from qiskit import QuantumCircuit, transpile
from qiskit.quantum_info import Clifford

from .envelope import QuantumAgentError, exhaustive, truncated

# Aer's state vector at this width is 2^24 complex doubles, about 256 MiB. Clifford
# circuits use the stabilizer method and are not bound by it.
MAX_DENSE_QUBITS = 24
MAX_SHOTS = 100_000
TOP_OUTCOMES = 32


def _is_clifford(qc: QuantumCircuit) -> bool:
    body = qc.remove_final_measurements(inplace=False)
    try:
        Clifford(body)
        return True
    except Exception:
        return False


def shape_counts(counts: dict[str, int], shots: int, top: int = TOP_OUTCOMES) -> dict[str, Any]:
    """Counts cut to the most frequent outcomes, saying so when they are cut."""
    ordered = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))
    shown = dict(ordered[:top])
    omitted = len(ordered) - len(shown)
    if omitted:
        completeness = truncated(
            len(shown),
            omitted,
            f"The {len(shown)} most frequent of {len(ordered)} distinct outcomes; the omitted "
            f"ones account for {shots - sum(shown.values())} of {shots} shots.",
        )
    else:
        completeness = exhaustive(f"Every outcome observed in {shots} shots.")
    return {"counts": shown, "distinct_outcomes": len(ordered), "completeness": completeness}


def simulate(qc: QuantumCircuit, shots: int, seed: int, noise_backend=None) -> dict[str, Any]:
    from qiskit_aer import AerSimulator

    if not 1 <= shots <= MAX_SHOTS:
        raise QuantumAgentError("shots_out_of_range", f"shots must be between 1 and {MAX_SHOTS}.")
    if qc.num_clbits == 0:
        raise QuantumAgentError(
            "nothing_measured", "The circuit measures nothing, so a simulation has no counts to return."
        )
    clifford = _is_clifford(qc)
    if noise_backend is None and not clifford and qc.num_qubits > MAX_DENSE_QUBITS:
        raise QuantumAgentError(
            "simulation_too_wide",
            f"{qc.num_qubits} qubits of non-Clifford circuit is past this machine's "
            f"{MAX_DENSE_QUBITS}-qubit limit for dense simulation.",
        )

    if noise_backend is None:
        sim = AerSimulator(method="stabilizer" if clifford else "automatic", seed_simulator=seed)
        # Level 0: translate gates Aer lacks, and resynthesise nothing. At higher levels the
        # output against Aer's target varies with Python's per-process hash seed, and some
        # variants carry rotations the stabilizer method rejects, so a Clifford circuit
        # failed at random and a seeded run was not reproducible from its output.
        runnable = transpile(qc, sim, seed_transpiler=seed, optimization_level=0)
        mode = "ideal"
    else:
        sim = AerSimulator.from_backend(noise_backend, seed_simulator=seed)
        runnable = transpile(qc, noise_backend, seed_transpiler=seed, optimization_level=2)
        mode = f"noisy: a model of {noise_backend.name}'s recorded calibration"

    try:
        result = sim.run(runnable, shots=shots).result()
        counts = result.get_counts()
    except Exception as exc:
        raise QuantumAgentError("simulation_failed", f"Simulation failed: {exc}") from exc

    out = {"mode": mode, "shots": shots, "seed": seed, "method": "stabilizer" if clifford and noise_backend is None else "automatic"}
    out.update(shape_counts(counts, shots))
    return out
