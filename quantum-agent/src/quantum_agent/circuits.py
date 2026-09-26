"""
Circuits in, circuits out: parsing OpenQASM, and templates worth running first.

Every circuit that leaves this module leaves as OpenQASM 3 text together with
its commitment (see `commit.py`), because the text is what gets hashed, sent
and anchored. A `QuantumCircuit` object is a working copy of it.
"""

from __future__ import annotations

import random
from typing import Any

from qiskit import QuantumCircuit, qasm2, qasm3

from .commit import circuit_commitment
from .envelope import QuantumAgentError

MAX_TEMPLATE_QUBITS = 127
MAX_MIRROR_LAYERS = 64

# Single-qubit Cliffords a mirror layer draws from. Each has an exact inverse in
# the standard gate library, so the mirrored half is exact rather than approximate.
_LAYER_GATES = ("id", "h", "s", "sdg", "x", "y", "z", "sx")


def load_qasm(text: str) -> QuantumCircuit:
    """Parse OpenQASM 3, or OpenQASM 2 when the header says so."""
    head = text.lstrip()[:32]
    try:
        if head.startswith("OPENQASM 2"):
            return qasm2.loads(text, custom_instructions=qasm2.LEGACY_CUSTOM_INSTRUCTIONS)
        return qasm3.loads(text)
    except Exception as exc:  # the parsers raise several unrelated types
        raise QuantumAgentError(
            "qasm_invalid",
            f"Could not parse the circuit: {exc}",
            "Send OpenQASM 3 (or OpenQASM 2 with an 'OPENQASM 2.0;' header) including "
            "'include \"stdgates.inc\";' for standard gates.",
        ) from exc


def emit(circuit: QuantumCircuit, meta: dict[str, Any] | None = None) -> dict[str, Any]:
    """A circuit as it travels: its QASM 3 text, the commitment to that text, and its shape."""
    text = qasm3.dumps(circuit)
    out: dict[str, Any] = {
        "qasm": text,
        "commitment": circuit_commitment(text),
        "qubits": circuit.num_qubits,
        "clbits": circuit.num_clbits,
        "depth": circuit.depth(),
        "ops": dict(circuit.count_ops()),
    }
    if meta:
        out["template"] = meta
    return out


def _check_width(n: int, minimum: int) -> None:
    if not minimum <= n <= MAX_TEMPLATE_QUBITS:
        raise QuantumAgentError(
            "width_out_of_range",
            f"qubits must be between {minimum} and {MAX_TEMPLATE_QUBITS}; got {n}.",
        )


def bell() -> tuple[QuantumCircuit, dict[str, Any]]:
    qc = QuantumCircuit(2)
    qc.h(0)
    qc.cx(0, 1)
    qc.measure_all()
    return qc, {"name": "bell", "ideal": "'00' and '11', each with probability 1/2"}


def ghz(n: int) -> tuple[QuantumCircuit, dict[str, Any]]:
    _check_width(n, 2)
    qc = QuantumCircuit(n)
    qc.h(0)
    for i in range(n - 1):
        qc.cx(i, i + 1)
    qc.measure_all()
    return qc, {
        "name": "ghz",
        "ideal": f"all-zeros and all-ones over {n} bits, each with probability 1/2",
    }


def mirror(n: int, layers: int, seed: int) -> tuple[QuantumCircuit, dict[str, Any]]:
    """
    A mirror circuit: random Clifford layers, their exact inverse, then an X on a
    random subset of qubits.

    Without noise, it produces exactly one bitstring, and that bitstring is known
    from the construction. The success probability of a hardware run is then
    checkable from its counts alone, at any width. That makes it the first circuit
    class Tessarq's Q2 verifiers can score. The final X layer makes the target
    something other than all-zeros, so a device stuck at |0> cannot pass.

    `seed` fixes everything: the same (n, layers, seed) is the same circuit, and
    the same QASM text, and the same commitment.
    """
    _check_width(n, 1)
    if not 1 <= layers <= MAX_MIRROR_LAYERS:
        raise QuantumAgentError(
            "layers_out_of_range", f"layers must be between 1 and {MAX_MIRROR_LAYERS}; got {layers}."
        )
    rng = random.Random(seed)
    half = QuantumCircuit(n)
    for _ in range(layers):
        for q in range(n):
            gate = rng.choice(_LAYER_GATES)
            if gate != "id":
                getattr(half, gate)(q)
        order = list(range(n))
        rng.shuffle(order)
        for a, b in zip(order[0::2], order[1::2]):
            half.cx(a, b)

    flips = [q for q in range(n) if rng.random() < 0.5]
    if not flips:
        flips = [rng.randrange(n)]

    qc = QuantumCircuit(n)
    qc.compose(half, inplace=True)
    qc.barrier()
    qc.compose(half.inverse(), inplace=True)
    qc.barrier()
    for q in flips:
        qc.x(q)
    qc.measure_all()

    # Qiskit's count keys put classical bit 0 on the right.
    ideal = "".join("1" if q in flips else "0" for q in reversed(range(n)))
    return qc, {
        "name": "mirror",
        "layers": layers,
        "seed": seed,
        "ideal_outcome": ideal,
        "bit_order": "qiskit: classical bit 0 is the rightmost character",
    }


TEMPLATES = ("bell", "ghz", "mirror")


def build(template: str, qubits: int | None = None, layers: int | None = None, seed: int | None = None):
    if template == "bell":
        return bell()
    if template == "ghz":
        return ghz(qubits if qubits is not None else 3)
    if template == "mirror":
        return mirror(
            qubits if qubits is not None else 4,
            layers if layers is not None else 4,
            seed if seed is not None else 0,
        )
    raise QuantumAgentError(
        "unknown_template", f"No template named {template!r}.", f"Templates: {', '.join(TEMPLATES)}."
    )
