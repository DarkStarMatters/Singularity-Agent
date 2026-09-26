"""
What a result from this circuit could ever prove, decided before it runs.

Tessarq's Q track (ROADMAP-v0.2, "What can honestly be proven") separates three
claims about a quantum job and gives each a ceiling. This module works out which
ceiling applies to a given circuit, so the answer arrives *before* QPU time is
spent on a run whose output nobody can check.

| class           | how a result is checked                        | correctness ceiling      |
|-----------------|------------------------------------------------|--------------------------|
| `deterministic` | one ideal bitstring: success probability       | verified_implementation  |
| `clifford`      | stabilizer simulation: support, expectations   | verified_implementation  |
| `small`         | state vector (<= 12 qubits): Hellinger fidelity| verified_implementation  |
| `attested`      | none possible here: provider provenance only   | preliminary              |

The other two claims have the same ceiling for every circuit. "It ran on the
QPU that was claimed" rests on the provider's job record: `preliminary`. "The
hardware is quantum" needs proof-of-quantumness protocols: `hypothetical`.
"""

from __future__ import annotations

from typing import Any

from qiskit import QuantumCircuit
from qiskit.quantum_info import Clifford, Pauli, StabilizerState, Statevector

from .thinline import EvidenceLabel

# Tessarq's bound for fixed-point state-vector verification (ROADMAP-v0.2, Q2).
STATEVECTOR_MAX_QUBITS = 12

_DYNAMIC = {"if_else", "while_loop", "for_loop", "switch_case", "reset"}
_IGNORABLE = {"barrier", "delay"}


def _final_measurements(qc: QuantumCircuit) -> tuple[QuantumCircuit, dict[int, int], list[str]]:
    """
    Split a circuit into its unitary body and its terminal measurements.

    Returns the body, a map from qubit index to the classical bit it is measured
    into, and reasons the circuit is not "unitary then measure", if any.
    """
    reasons: list[str] = []
    body = qc.copy_empty_like()
    measured: dict[int, int] = {}
    measured_qubits: set[int] = set()

    for inst in qc.data:
        name = inst.operation.name
        qubits = [qc.find_bit(q).index for q in inst.qubits]
        if name == "measure":
            q = qubits[0]
            c = qc.find_bit(inst.clbits[0]).index
            measured[q] = c
            measured_qubits.add(q)
            continue
        if name in _IGNORABLE:
            continue
        if name in _DYNAMIC:
            reasons.append(f"uses `{name}`, so the circuit is not a single unitary")
            continue
        if measured_qubits.intersection(qubits):
            reasons.append("a qubit is operated on after being measured (mid-circuit measurement)")
        body.append(inst)

    body.remove_final_measurements(inplace=True)
    return body, measured, sorted(set(reasons))


def _compact(body: QuantumCircuit, measured: dict[int, int]) -> tuple[QuantumCircuit, dict[int, int]]:
    """
    Drop qubits nothing touches.

    A circuit transpiled for a 156-qubit backend declares 156 qubits and usually
    uses a handful. Its width for simulation is the number it uses, and counting
    the declared width would call a two-qubit Bell pair uncheckable.
    """
    active = set(measured)
    for inst in body.data:
        active.update(body.find_bit(q).index for q in inst.qubits)
    order = sorted(active)
    index = {q: i for i, q in enumerate(order)}
    small = QuantumCircuit(len(order))
    for inst in body.data:
        small.append(inst.operation, [index[body.find_bit(q).index] for q in inst.qubits])
    return small, {index[q]: c for q, c in measured.items()}


def _bitstring(bits: dict[int, int], measured: dict[int, int], num_clbits: int) -> str:
    """Qiskit count-key form: classical bit 0 rightmost; unmeasured bits read 0."""
    chars = ["0"] * num_clbits
    for q, c in measured.items():
        chars[num_clbits - 1 - c] = str(bits[q])
    return "".join(chars)


def classify(qc: QuantumCircuit) -> dict[str, Any]:
    body, measured, reasons = _final_measurements(qc)
    out: dict[str, Any] = {
        "qubits": qc.num_qubits,
        "measured_qubits": len(measured),
        "ops": dict(qc.count_ops()),
    }

    if not measured:
        reasons.append("nothing is measured, so a run returns no counts to check")
    if len(qc.cregs) > 1:
        reasons.append(
            "more than one classical register; checks here read a single register's count keys"
        )

    cls: str | None = None
    ideal: str | None = None
    detail: list[str] = []

    if not reasons:
        body, measured = _compact(body, measured)
        out["active_qubits"] = body.num_qubits
        try:
            clifford = Clifford(body)
        except Exception:
            clifford = None

        if clifford is not None:
            state = StabilizerState(clifford)
            outcomes: dict[int, int] = {}
            for q in measured:
                label = ["I"] * body.num_qubits
                label[body.num_qubits - 1 - q] = "Z"
                z = round(state.expectation_value(Pauli("".join(label))).real)
                if z == 0:
                    break
                outcomes[q] = 0 if z == 1 else 1
            if len(outcomes) == len(measured):
                cls = "deterministic"
                ideal = _bitstring(outcomes, measured, qc.num_clbits)
                detail.append("Clifford circuit with a single ideal outcome, found by stabilizer simulation")
            else:
                cls = "clifford"
                detail.append(
                    "Clifford circuit: the ideal support and stabilizer expectations are computable "
                    "at any width"
                )
        elif body.num_qubits <= STATEVECTOR_MAX_QUBITS:
            probs = Statevector(body).probabilities_dict(qargs=sorted(measured))
            top = [k for k, p in probs.items() if p > 1 - 1e-9]
            if top:
                # probabilities_dict orders its key by qargs, highest-listed rightmost.
                key = top[0]
                order = sorted(measured)
                bits = {q: int(key[len(order) - 1 - i]) for i, q in enumerate(order)}
                cls = "deterministic"
                ideal = _bitstring(bits, measured, qc.num_clbits)
                detail.append("single ideal outcome, found by state-vector simulation")
            else:
                cls = "small"
                detail.append(
                    f"non-Clifford, at most {STATEVECTOR_MAX_QUBITS} qubits: the ideal distribution "
                    "is computable, so Hellinger fidelity can be checked"
                )
        else:
            reasons.append(
                f"non-Clifford and more than {STATEVECTOR_MAX_QUBITS} active qubits, so the ideal output "
                "is not computable here. Mirror circuits built from non-Clifford gates are not "
                "recognised at this width."
            )

    if cls is None:
        cls = "attested"
        correctness = EvidenceLabel.PRELIMINARY
    else:
        correctness = EvidenceLabel.VERIFIED_IMPLEMENTATION

    out["class"] = cls
    if ideal is not None:
        out["ideal_outcome"] = ideal
        out["bit_order"] = "qiskit: classical bit 0 is the rightmost character"
    out["why"] = detail or reasons
    out["label_ceilings"] = {
        "result_is_correct": correctness.value,
        "ran_on_claimed_qpu": EvidenceLabel.PRELIMINARY.value,
        "hardware_is_quantum": EvidenceLabel.HYPOTHETICAL.value,
    }
    out["ceiling_note"] = (
        "Ceilings are the best a result could earn, not what it has earned. Nothing is verified "
        "until a run's counts are checked against the ideal."
    )
    return out
