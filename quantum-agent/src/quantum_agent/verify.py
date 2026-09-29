"""
Check a run's counts against what the circuit should have produced.

`classify` says what a result could ever prove. This is the other half: given
the counts a run actually returned, how much of it the circuit accounts for, and
whether that clears a threshold. One method per verifiable class, matching
Tessarq's Q2 (ROADMAP-v0.2):

| class           | method               | score                                      |
|-----------------|----------------------|--------------------------------------------|
| `deterministic` | `success_probability`| shots on the one ideal outcome / shots     |
| `clifford`      | `stabilizer_support` | shots inside the ideal support / shots     |
| `small`         | `hellinger_fidelity` | (sum over x of sqrt(p_ideal(x) q_run(x)))^2|
| `attested`      | none                 | refused: nothing here can check it         |

Scores are parts per million, and the verdict is integer arithmetic:
`pass` iff score_numerator * 1_000_000 >= threshold_ppm * denominator. No
rounding happens before the comparison, so the Rust verifier reaches the same
verdict from the same counts. Hellinger fidelity is the exception: it needs
square roots, and until Tessarq fixes its fixed-point format the verdict is
taken on a float, which the vectors mark with a tolerance.

What a pass earns is the `result_is_correct` claim at `verified_implementation`,
and nothing else. That these counts came from the job and device they are
attributed to rests on the provider's record (`preliminary`), and a circuit
that can be checked classically can also be simulated classically, so a pass
says nothing about whether the hardware is quantum (`hypothetical`).
"""

from __future__ import annotations

import math
from typing import Any

from qiskit import QuantumCircuit
from qiskit.quantum_info import Clifford, Statevector

from .classify import _bitstring, _compact, _final_measurements, classify
from .envelope import QuantumAgentError
from .stabilizer import z_constraints
from .thinline import EvidenceLabel

PPM = 1_000_000


def measurement_map(qc: QuantumCircuit) -> tuple[QuantumCircuit, dict[int, int]]:
    """
    The unitary body, compacted to the qubits it uses, and which classical bit
    each measured qubit lands in.

    Refuses a qubit measured into two bits, or a bit written twice: a count key
    then has two readings, and scoring either one would be a guess.
    """
    seen_q: set[int] = set()
    seen_c: set[int] = set()
    for inst in qc.data:
        if inst.operation.name != "measure":
            continue
        q = qc.find_bit(inst.qubits[0]).index
        c = qc.find_bit(inst.clbits[0]).index
        if q in seen_q or c in seen_c:
            raise QuantumAgentError(
                "measurement_map_ambiguous",
                "A qubit is measured more than once, or a classical bit is written more than once.",
                "Measure each qubit once, into its own classical bit.",
            )
        seen_q.add(q)
        seen_c.add(c)
    body, measured, _ = _final_measurements(qc)
    return _compact(body, measured)


def parse_counts(counts: dict[str, int], num_clbits: int, shots: int | None) -> tuple[dict[int, int], int]:
    """
    Count keys to integers (bit c of the integer is classical bit c) and the shot total.

    The total is the sum of the counts. When the caller also says how many shots
    ran and the two disagree, the histogram is missing outcomes, and a score over
    it would be a score over the part somebody chose to keep.
    """
    if not counts:
        raise QuantumAgentError("counts_empty", "No counts were given, so there is nothing to check.")
    parsed: dict[int, int] = {}
    for key, n in counts.items():
        if " " in key:
            raise QuantumAgentError(
                "counts_multiple_registers",
                f"Count key {key!r} spans several classical registers.",
                "Verification reads one register; measure into a single register.",
            )
        if len(key) != num_clbits or set(key) - {"0", "1"}:
            raise QuantumAgentError(
                "counts_key_invalid",
                f"Count key {key!r} is not a {num_clbits}-bit binary string.",
                "Keys are Qiskit's form: one character per classical bit, bit 0 rightmost.",
            )
        if isinstance(n, bool) or not isinstance(n, int) or n < 0:
            raise QuantumAgentError("counts_value_invalid", f"Count for {key!r} is not a non-negative integer.")
        value = int(key, 2)
        parsed[value] = parsed.get(value, 0) + n
    total = sum(parsed.values())
    if total == 0:
        raise QuantumAgentError("counts_empty", "The counts add up to zero shots.")
    if shots is not None and shots != total:
        raise QuantumAgentError(
            "counts_incomplete",
            f"The counts add up to {total} shots, but {shots} ran.",
            "Pass the full histogram. A histogram cut to its top outcomes cannot be scored.",
        )
    return parsed, total


def _verdict(numerator: int, denominator: int, threshold_ppm: int | None) -> str:
    if threshold_ppm is None:
        return "not_judged"
    return "pass" if numerator * PPM >= threshold_ppm * denominator else "fail"


def verify(
    qc: QuantumCircuit,
    counts: dict[str, int],
    threshold_ppm: int | None = None,
    shots: int | None = None,
) -> dict[str, Any]:
    if threshold_ppm is not None and not 0 <= threshold_ppm <= PPM:
        raise QuantumAgentError("threshold_out_of_range", f"threshold_ppm must be between 0 and {PPM}.")

    cls = classify(qc)
    if cls["class"] == "attested":
        raise QuantumAgentError(
            "not_verifiable",
            "This circuit's output cannot be checked from its counts: " + "; ".join(cls["why"]),
            "Only deterministic, Clifford and small (<= 12 active qubits) circuits can be verified.",
        )

    width = qc.num_clbits
    parsed, total = parse_counts(counts, width, shots)
    body, measured = measurement_map(qc)
    out: dict[str, Any] = {"class": cls["class"], "shots": total, "threshold_ppm": threshold_ppm}

    if cls["class"] == "deterministic":
        ideal = cls["ideal_outcome"]
        hits = parsed.get(int(ideal, 2), 0)
        out["method"] = "success_probability"
        out["ideal_outcome"] = ideal
        out["score"] = {"numerator": hits, "denominator": total, "ppm": hits * PPM // total}
        out["verdict"] = _verdict(hits, total, threshold_ppm)

    elif cls["class"] == "clifford":
        constraints = z_constraints(Clifford(body), measured, width)
        inside = sum(n for v, n in parsed.items() if all(c.holds(v) for c in constraints))
        agreement = [(sum(n for v, n in parsed.items() if c.holds(v)), c.mask, c) for c in constraints]
        out["method"] = "stabilizer_support"
        out["support"] = {
            "dimension": width - len(constraints),
            "constraints": [c.to_dict() for c in constraints],
            "form": "reduced row echelon over classical bits, pivot on the lowest bit; unique",
        }
        out["score"] = {"numerator": inside, "denominator": total, "ppm": inside * PPM // total}
        if agreement:
            # Which parity the run broke most often: where to look when the score is low.
            hits, _, worst = min(agreement, key=lambda a: a[:2])
            out["weakest_constraint"] = {**worst.to_dict(), "agreement_ppm": hits * PPM // total}
        else:
            out["weakest_constraint"] = None
        out["verdict"] = _verdict(inside, total, threshold_ppm)

    else:
        order = sorted(measured)
        probs = Statevector(body).probabilities_dict(qargs=order)
        ideal: dict[int, float] = {}
        for key, p in probs.items():
            bits = {q: int(key[len(order) - 1 - i]) for i, q in enumerate(order)}
            value = int(_bitstring(bits, measured, width), 2)
            ideal[value] = ideal.get(value, 0.0) + p
        overlap = sum(math.sqrt(ideal.get(v, 0.0) * n / total) for v, n in parsed.items())
        fidelity = min(overlap * overlap, 1.0)
        out["method"] = "hellinger_fidelity"
        out["fidelity"] = fidelity
        out["score"] = {"ppm": math.floor(fidelity * PPM)}
        out["verdict"] = (
            "not_judged" if threshold_ppm is None else ("pass" if fidelity * PPM >= threshold_ppm else "fail")
        )
        out["precision_note"] = (
            "Computed in floating point. Tessarq's Q2 will compute this in fixed point, and a "
            "score within a few ppm of the threshold may be judged differently there."
        )

    earned = {"pass": EvidenceLabel.VERIFIED_IMPLEMENTATION.value, "fail": EvidenceLabel.REJECTED.value}
    out["labels"] = {
        "result_is_correct": earned.get(out["verdict"]),
        "ran_on_claimed_qpu": EvidenceLabel.PRELIMINARY.value,
        "hardware_is_quantum": EvidenceLabel.HYPOTHETICAL.value,
    }
    out["note"] = (
        "This checks the counts against the circuit and nothing more. That they came from the job "
        "and device they are attributed to rests on the provider's record, and a circuit that can "
        "be checked classically can be simulated classically."
    )
    if out["verdict"] == "not_judged":
        out["note"] += " No threshold was given, so no label is earned: the score is reported only."
    return out
