"""
Test vectors for Tessarq's Q2 verifiers, generated from the Python ones.

The Rust verifiers have to reach the same verdict from the same counts, so the
cases are written down once, here, and committed as `vectors/verify-v1.json`.
`tests/test_vectors.py` regenerates the file and fails if it differs, so the
vectors cannot drift from the code that defines them.

Each case carries the circuit as OpenQASM 3 text with its commitment, the
counts, and the expected outcome. Integer methods are exact: a Rust verifier
must match `score` and `verdict` bit for bit, and `support.constraints` in the
canonical form. Hellinger cases carry `fidelity` rounded to 9 places and a
tolerance, because the fixed-point format is Tessarq's to fix.

Regenerate with: `uv run python -m quantum_agent.vectors`
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .circuits import build, emit, load_qasm
from .commit import circuit_commitment
from .envelope import QuantumAgentError
from .verify import verify

VERSION = 1
PATH = Path(__file__).resolve().parents[2] / "vectors" / f"verify-v{VERSION}.json"
HEAD = 'OPENQASM 3.0;\ninclude "stdgates.inc";\n'
HELLINGER_TOLERANCE = 1e-6


def _template(template: str, *args) -> str:
    qc, meta = build(template, *args)
    return emit(qc, meta)["qasm"]


def _flip(bits: str, i: int) -> str:
    return bits[:i] + ("1" if bits[i] == "0" else "0") + bits[i + 1 :]


def _cases() -> list[dict[str, Any]]:
    mirror5 = _template("mirror", 5, 3, 2)
    ideal5 = build("mirror", 5, 3, 2)[1]["ideal_outcome"]
    mirror24 = _template("mirror", 24, 6, 7)
    ideal24 = build("mirror", 24, 6, 7)[1]["ideal_outcome"]
    ghz4 = _template("ghz", 4)
    ghz16 = _template("ghz", 16)
    small = HEAD + "bit[2] c;\nqubit[2] q;\nrx(pi/3) q[0];\ncx q[0], q[1];\nc = measure q;\n"
    partial = HEAD + "bit[3] c;\nqubit[3] q;\nh q[0];\ncx q[0], q[1];\ncx q[1], q[2];\nc[0] = measure q[0];\nc[2] = measure q[2];\n"
    wide = HEAD + "bit[14] c;\nqubit[14] q;\n" + "".join(f"rx(0.3) q[{i}];\n" for i in range(14)) + "c = measure q;\n"

    return [
        {"name": "mirror-pass-at-threshold", "qasm": mirror5,
         "counts": {ideal5: 900, "00000": 60, _flip(ideal5, 0): 40}, "threshold_ppm": 900_000,
         "why": "Exactly at the threshold passes: 900 * 10^6 >= 900000 * 1000."},
        {"name": "mirror-fail-one-ppm-over", "qasm": mirror5,
         "counts": {ideal5: 900, "00000": 60, _flip(ideal5, 0): 40}, "threshold_ppm": 900_001,
         "why": "One ppm above the score fails. No rounding before the comparison."},
        {"name": "mirror-score-floors", "qasm": mirror5,
         "counts": {ideal5: 2, "00000": 1}, "threshold_ppm": 666_667,
         "why": "2/3 is 666666.67 ppm; the reported ppm floors to 666666 and the verdict is exact: 2*10^6 < 666667*3."},
        {"name": "mirror-stuck-at-zero", "qasm": mirror5,
         "counts": {"00000": 1000}, "threshold_ppm": 1,
         "why": "A device that returns all-zeros cannot pass: the X layer moves the target off it."},
        {"name": "mirror-not-judged", "qasm": mirror5, "counts": {ideal5: 7, "11111": 3},
         "why": "No threshold: the score is reported and no label is earned."},
        {"name": "mirror-24-qubits", "qasm": mirror24,
         "counts": {ideal24: 3500, _flip(ideal24, 5): 300, _flip(ideal24, 17): 200}, "threshold_ppm": 850_000},
        {"name": "ghz4-support", "qasm": ghz4,
         "counts": {"0000": 480, "1111": 470, "0001": 50}, "threshold_ppm": 950_000,
         "why": "0001 breaks parity on bits {0,3}: the weakest constraint."},
        {"name": "ghz16-support-fail", "qasm": ghz16,
         "counts": {"0" * 16: 400, "1" * 16: 400, "0" * 15 + "1": 100, "1" * 15 + "0": 100}, "threshold_ppm": 900_000},
        {"name": "clifford-partial-measurement", "qasm": partial,
         "counts": {"000": 500, "101": 490, "001": 10}, "threshold_ppm": 990_000,
         "why": "q[1] is not measured and c[1] is never written, so c[1] must read 0."},
        {"name": "small-hellinger", "qasm": small,
         "counts": {"00": 700, "11": 250, "01": 50}, "threshold_ppm": 950_000},
        {"name": "error-attested", "qasm": wide, "counts": {"0" * 14: 1}},
        {"name": "error-truncated-histogram", "qasm": mirror5, "counts": {ideal5: 900}, "shots": 1000},
        {"name": "error-key-width", "qasm": mirror5, "counts": {"0000": 1}},
        {"name": "error-multiple-registers", "qasm": mirror5, "counts": {"00 000": 1}},
    ]


def _expected(result: dict[str, Any]) -> dict[str, Any]:
    keep = ("class", "method", "shots", "threshold_ppm", "verdict", "labels", "ideal_outcome", "weakest_constraint")
    out = {k: result[k] for k in keep if k in result}
    if result["method"] == "hellinger_fidelity":
        out["fidelity"] = round(result["fidelity"], 9)
        out["tolerance"] = HELLINGER_TOLERANCE
        out["score"] = result["score"]
    else:
        out["score"] = result["score"]
    if "support" in result:
        out["support"] = {k: result["support"][k] for k in ("dimension", "constraints")}
    return out


def generate() -> dict[str, Any]:
    cases = []
    for case in _cases():
        qasm = case["qasm"]
        entry: dict[str, Any] = {"name": case["name"]}
        if "why" in case:
            entry["why"] = case["why"]
        entry["qasm"] = qasm
        entry["commitment"] = circuit_commitment(qasm)
        entry["counts"] = case["counts"]
        for key in ("shots", "threshold_ppm"):
            if key in case:
                entry[key] = case[key]
        try:
            result = verify(load_qasm(qasm), case["counts"], case.get("threshold_ppm"), case.get("shots"))
            entry["expected"] = _expected(result)
        except QuantumAgentError as exc:
            entry["expected"] = {"error": exc.code}
        cases.append(entry)
    return {
        "version": VERSION,
        "description": (
            "Verifier vectors for Tessarq Q2. Count keys are Qiskit's: classical bit 0 is the "
            "rightmost character. Integer scores and verdicts are exact; pass iff "
            "numerator * 1000000 >= threshold_ppm * denominator. Constraints are in reduced row "
            "echelon form over classical bits, pivoting on the lowest bit. Hellinger fidelity "
            "matches within `tolerance`."
        ),
        "generated_by": "quantum-agent: uv run python -m quantum_agent.vectors",
        "cases": cases,
    }


def render() -> str:
    return json.dumps(generate(), indent=2, ensure_ascii=False) + "\n"


if __name__ == "__main__":
    PATH.parent.mkdir(exist_ok=True)
    PATH.write_text(render(), encoding="utf-8", newline="\n")
    print(f"wrote {PATH}")
