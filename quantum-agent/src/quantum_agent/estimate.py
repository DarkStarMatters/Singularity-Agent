"""
What a circuit becomes on a given backend, and roughly what it will cost, before
any QPU time is spent.

The transpile is local and seeded, so the same circuit on the same calibration
gives the same answer every time. The two numbers derived from it are
heuristics and are labelled as such:

- **Estimated success probability (ESP)**: the product of (1 - error) over every
  gate and measurement in the transpiled circuit. It ignores crosstalk,
  coherent errors, idle decoherence and any error suppression, so it is a rough
  guide for comparing layouts, not a prediction of a run's fidelity. Fire Opal
  in particular exists to beat it.
- **QPU time lower bound**: the scheduled circuit duration times the shot count.
  Billed usage is higher: it also includes the repetition delay between shots,
  compilation and control-system overhead, none of which is modelled.
"""

from __future__ import annotations

import math
from typing import Any

from qiskit import QuantumCircuit, transpile

from .envelope import QuantumAgentError

TRANSPILE_SEED = 7
MAX_SHOTS = 1_000_000


def estimate(qc: QuantumCircuit, backend, shots: int, optimization_level: int = 2) -> dict[str, Any]:
    if not 1 <= shots <= MAX_SHOTS:
        raise QuantumAgentError("shots_out_of_range", f"shots must be between 1 and {MAX_SHOTS}.")
    if qc.num_qubits > backend.num_qubits:
        raise QuantumAgentError(
            "circuit_too_wide",
            f"The circuit needs {qc.num_qubits} qubits; {backend.name} has {backend.num_qubits}.",
        )
    try:
        tq = transpile(
            qc, backend, optimization_level=optimization_level, seed_transpiler=TRANSPILE_SEED
        )
    except Exception as exc:
        raise QuantumAgentError("transpile_failed", f"Transpiling for {backend.name} failed: {exc}") from exc

    target = backend.target
    log_esp = 0.0
    unknown: set[str] = set()
    two_qubit = 0
    for inst in tq.data:
        name = inst.operation.name
        if name in ("barrier", "delay"):
            continue
        qargs = tuple(tq.find_bit(q).index for q in inst.qubits)
        if len(qargs) == 2:
            two_qubit += 1
        props = target[name].get(qargs) if name in target.operation_names else None
        if props is None or props.error is None:
            unknown.add(name)
            continue
        if props.error >= 1:
            log_esp = -math.inf
            continue
        log_esp += math.log1p(-props.error)

    try:
        duration = tq.estimate_duration(target, unit="s")
    except Exception:
        duration = None

    layout = tq.layout.final_index_layout() if tq.layout is not None else None
    out: dict[str, Any] = {
        "backend": backend.name,
        "optimization_level": optimization_level,
        "transpile_seed": TRANSPILE_SEED,
        "depth": tq.depth(),
        "two_qubit_gates": two_qubit,
        "ops": dict(tq.count_ops()),
        "physical_qubits": layout[: qc.num_qubits] if layout else None,
        "estimated_success_probability": math.exp(log_esp),
        "esp_note": (
            "Product of (1 - error) over every operation. It ignores crosstalk, coherent and "
            "idle errors and any error suppression: a guide for comparing layouts, not a prediction."
        ),
    }
    if unknown:
        out["esp_missing_errors_for"] = sorted(unknown)
        out["esp_note"] += (
            " Some operations have no error in the calibration, so they were counted as "
            "error-free and the estimate is optimistic."
        )
    if duration is not None:
        out["circuit_duration_s"] = duration
        out["qpu_seconds_lower_bound"] = duration * shots
        out["qpu_time_note"] = (
            "Circuit duration x shots. Billed usage is higher: repetition delay, compilation "
            "and control overhead are not modelled."
        )
    else:
        out["qpu_seconds_lower_bound"] = None
        out["qpu_time_note"] = "The backend reports no gate durations, so no time could be estimated."
    return out
