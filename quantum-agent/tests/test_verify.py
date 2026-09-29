import random

import pytest
from qiskit import QuantumCircuit
from qiskit.quantum_info import Clifford, Statevector, random_clifford

from quantum_agent.circuits import build, load_qasm
from quantum_agent.envelope import QuantumAgentError
from quantum_agent.stabilizer import Constraint, rref, z_constraints
from quantum_agent.verify import measurement_map, verify

HEAD = 'OPENQASM 3.0;\ninclude "stdgates.inc";\n'


def ideal_support(qc: QuantumCircuit) -> set[int]:
    """Every outcome with nonzero probability, by brute-force state vector."""
    body, measured = measurement_map(qc)
    order = sorted(measured)
    out = set()
    for key, p in Statevector(body).probabilities_dict(qargs=order).items():
        if p > 1e-9:
            value = 0
            for i, q in enumerate(order):
                value |= int(key[len(order) - 1 - i]) << measured[q]
            out.add(value)
    return out


def constrained_support(qc: QuantumCircuit) -> set[int]:
    body, measured = measurement_map(qc)
    cs = z_constraints(Clifford(body), measured, qc.num_clbits)
    return {v for v in range(2**qc.num_clbits) if all(c.holds(v) for c in cs)}


@pytest.mark.parametrize("seed", range(40))
def test_constraints_describe_exactly_the_ideal_support(seed):
    rng = random.Random(seed)
    n = rng.randint(1, 6)
    qc = QuantumCircuit(n, n + rng.randint(0, 1))
    qc.compose(random_clifford(n, seed=seed).to_circuit(), inplace=True)
    qubits = rng.sample(range(n), rng.randint(1, n))
    bits = rng.sample(range(qc.num_clbits), len(qubits))
    for q, c in zip(qubits, bits):
        qc.measure(q, c)
    assert constrained_support(qc) == ideal_support(qc)


def test_rref_is_canonical_whatever_basis_it_is_given():
    a = [Constraint(0b011, 1), Constraint(0b110, 0)]
    b = [Constraint(0b101, 1), Constraint(0b011, 1), Constraint(0b110, 0)]
    assert rref(a, 3) == rref(b, 3) == [Constraint(0b101, 1), Constraint(0b110, 0)]


def test_rref_refuses_a_contradiction():
    with pytest.raises(ValueError):
        rref([Constraint(0b1, 0), Constraint(0b1, 1)], 1)


def mirror(n=5, layers=3, seed=2):
    qc, meta = build("mirror", n, layers, seed)
    return qc, meta["ideal_outcome"]


def test_mirror_scores_the_ideal_outcome_and_judges_in_integers():
    qc, ideal = mirror()
    other = "0" * len(ideal)
    counts = {ideal: 900, other: 100}
    r = verify(qc, counts, threshold_ppm=900_000)
    assert r["method"] == "success_probability"
    assert r["score"] == {"numerator": 900, "denominator": 1000, "ppm": 900_000}
    assert r["verdict"] == "pass"  # exactly at the threshold passes
    assert r["labels"]["result_is_correct"] == "verified_implementation"
    assert verify(qc, counts, threshold_ppm=900_001)["verdict"] == "fail"
    assert verify(qc, counts, threshold_ppm=900_001)["labels"]["result_is_correct"] == "rejected"


def test_a_device_stuck_at_zero_scores_nothing():
    qc, ideal = mirror()
    r = verify(qc, {"0" * len(ideal): 1000}, threshold_ppm=1)
    assert r["score"]["ppm"] == 0 and r["verdict"] == "fail"


def test_no_threshold_reports_without_earning_a_label():
    qc, ideal = mirror()
    r = verify(qc, {ideal: 10})
    assert r["verdict"] == "not_judged"
    assert r["labels"]["result_is_correct"] is None
    assert r["labels"]["ran_on_claimed_qpu"] == "preliminary"
    assert r["labels"]["hardware_is_quantum"] == "hypothetical"


def test_ghz_support_and_the_parity_it_broke():
    qc, _ = build("ghz", 4)
    r = verify(qc, {"0000": 480, "1111": 470, "0001": 50}, threshold_ppm=950_000)
    assert r["method"] == "stabilizer_support"
    assert r["support"]["dimension"] == 1
    assert r["support"]["constraints"] == [
        {"bits": [0, 3], "parity": 0},
        {"bits": [1, 3], "parity": 0},
        {"bits": [2, 3], "parity": 0},
    ]
    assert r["score"]["ppm"] == 950_000 and r["verdict"] == "pass"
    assert r["weakest_constraint"]["agreement_ppm"] == 950_000


def test_wide_clifford_is_checked_without_a_state_vector():
    qc, _ = build("ghz", 100)
    r = verify(qc, {"0" * 100: 5, "1" * 100: 5})
    assert r["score"]["ppm"] == 1_000_000
    assert len(r["support"]["constraints"]) == 99


def test_unconstrained_clifford_has_no_weakest_constraint():
    qc = load_qasm(HEAD + "bit[2] c;\nqubit[2] q;\nh q[0];\nh q[1];\nc = measure q;\n")
    r = verify(qc, {"00": 1, "01": 1, "10": 1, "11": 1})
    assert r["support"]["dimension"] == 2
    assert r["weakest_constraint"] is None
    assert r["score"]["ppm"] == 1_000_000


def test_small_non_clifford_uses_hellinger_fidelity():
    # rx(pi/3) is not Clifford: |0> with probability 3/4, |1> with 1/4.
    qc = load_qasm(HEAD + "bit[1] c;\nqubit[1] q;\nrx(pi/3) q[0];\nc = measure q;\n")
    assert verify(qc, {"0": 750, "1": 250})["fidelity"] == pytest.approx(1.0)
    r = verify(qc, {"0": 1000}, threshold_ppm=800_000)
    assert r["method"] == "hellinger_fidelity"
    assert r["fidelity"] == pytest.approx(0.75)
    assert r["verdict"] == "fail"


def test_attested_circuits_are_refused():
    body = "".join(f"rx(0.3) q[{i}];\n" for i in range(14))
    qc = load_qasm(HEAD + "bit[14] c;\nqubit[14] q;\n" + body + "c = measure q;\n")
    with pytest.raises(QuantumAgentError) as e:
        verify(qc, {"0" * 14: 1})
    assert e.value.code == "not_verifiable"


@pytest.mark.parametrize(
    "counts,shots,code",
    [
        ({}, None, "counts_empty"),
        ({"00000": 0}, None, "counts_empty"),
        ({"0000": 1}, None, "counts_key_invalid"),
        ({"0000x": 1}, None, "counts_key_invalid"),
        ({"00 000": 1}, None, "counts_multiple_registers"),
        ({"00000": -1}, None, "counts_value_invalid"),
        ({"00000": 1.5}, None, "counts_value_invalid"),
        ({"00000": 10}, 4000, "counts_incomplete"),
    ],
)
def test_counts_that_cannot_be_scored_are_refused(counts, shots, code):
    qc, _ = mirror()
    with pytest.raises(QuantumAgentError) as e:
        verify(qc, counts, shots=shots)
    assert e.value.code == code


def test_ambiguous_measurement_is_refused():
    qc = load_qasm(HEAD + "bit[2] c;\nqubit[1] q;\nx q[0];\nc[0] = measure q[0];\nc[1] = measure q[0];\n")
    with pytest.raises(QuantumAgentError) as e:
        verify(qc, {"11": 1})
    assert e.value.code == "measurement_map_ambiguous"


def test_threshold_out_of_range():
    qc, ideal = mirror()
    with pytest.raises(QuantumAgentError) as e:
        verify(qc, {ideal: 1}, threshold_ppm=1_000_001)
    assert e.value.code == "threshold_out_of_range"
