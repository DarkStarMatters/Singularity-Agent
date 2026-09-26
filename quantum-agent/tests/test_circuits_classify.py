import pytest
from qiskit import transpile

from quantum_agent.backends import get_backend
from quantum_agent.circuits import build, emit, load_qasm
from quantum_agent.classify import classify
from quantum_agent.envelope import QuantumAgentError

HEAD = 'OPENQASM 3.0;\ninclude "stdgates.inc";\n'


def roundtrip(template, *args):
    qc, meta = build(template, *args)
    out = emit(qc, meta)
    return out, classify(load_qasm(out["qasm"]))


def test_same_arguments_same_commitment():
    a, _ = roundtrip("mirror", 6, 4, 11)
    b, _ = roundtrip("mirror", 6, 4, 11)
    c, _ = roundtrip("mirror", 6, 4, 12)
    assert a["commitment"] == b["commitment"] != c["commitment"]


@pytest.mark.parametrize("n,layers,seed", [(1, 1, 0), (5, 3, 1), (12, 8, 2), (60, 4, 3)])
def test_mirror_ideal_outcome_is_what_the_classifier_derives(n, layers, seed):
    out, cls = roundtrip("mirror", n, layers, seed)
    assert cls["class"] == "deterministic"
    assert cls["ideal_outcome"] == out["template"]["ideal_outcome"]
    assert set(cls["ideal_outcome"]) != {"0"}, "the X layer must move the target off all-zeros"
    assert cls["label_ceilings"]["result_is_correct"] == "verified_implementation"


def test_bell_and_ghz_are_clifford_not_deterministic():
    for template, args in (("bell", ()), ("ghz", (7,))):
        _, cls = roundtrip(template, *args)
        assert cls["class"] == "clifford"
        assert "ideal_outcome" not in cls


def test_small_non_clifford():
    qc = load_qasm(HEAD + "bit[2] c;\nqubit[2] q;\nrx(0.3) q[0];\ncx q[0], q[1];\nc = measure q;\n")
    assert classify(qc)["class"] == "small"


def test_non_clifford_that_undoes_itself_is_deterministic():
    qc = load_qasm(
        HEAD + "bit[2] c;\nqubit[2] q;\nrx(0.3) q[0];\nrx(-0.3) q[0];\nx q[1];\nc = measure q;\n"
    )
    cls = classify(qc)
    assert cls["class"] == "deterministic"
    assert cls["ideal_outcome"] == "10"


def test_idle_declared_qubits_do_not_count_toward_width():
    qc = load_qasm(HEAD + "bit[1] c;\nqubit[40] q;\nrx(0.3) q[0];\nc[0] = measure q[0];\n")
    cls = classify(qc)
    assert cls["class"] == "small"
    assert cls["active_qubits"] == 1


def test_wide_non_clifford_is_attested_and_capped_at_preliminary():
    body = "".join(f"rx(0.3) q[{i}];\n" for i in range(14))
    qc = load_qasm(HEAD + "bit[14] c;\nqubit[14] q;\n" + body + "c = measure q;\n")
    cls = classify(qc)
    assert cls["class"] == "attested"
    assert cls["label_ceilings"]["result_is_correct"] == "preliminary"


def test_unmeasured_circuit_is_attested_with_a_reason():
    cls = classify(load_qasm(HEAD + "qubit[2] q;\nh q[0];\n"))
    assert cls["class"] == "attested"
    assert any("nothing is measured" in r for r in cls["why"])


def test_mid_circuit_measurement_is_attested():
    qc = load_qasm(
        HEAD + "bit[2] c;\nqubit[1] q;\nh q[0];\nc[0] = measure q[0];\nh q[0];\nc[1] = measure q[0];\n"
    )
    assert classify(qc)["class"] == "attested"


def test_transpiled_circuit_keeps_its_class_and_outcome():
    qc, meta = build("mirror", 5, 4, 3)
    backend, _ = get_backend("fake_fez")
    cls = classify(transpile(qc, backend, seed_transpiler=1))
    assert cls["class"] == "deterministic"
    assert cls["ideal_outcome"] == meta["ideal_outcome"]
    assert cls["active_qubits"] == 5


def test_other_claims_never_exceed_their_ceilings():
    _, cls = roundtrip("mirror", 4, 2, 0)
    assert cls["label_ceilings"]["ran_on_claimed_qpu"] == "preliminary"
    assert cls["label_ceilings"]["hardware_is_quantum"] == "hypothetical"


def test_bad_input_raises_structured_errors():
    with pytest.raises(QuantumAgentError) as e:
        load_qasm("not a circuit")
    assert e.value.code == "qasm_invalid"
    with pytest.raises(QuantumAgentError) as e:
        build("teleport")
    assert e.value.code == "unknown_template"
    with pytest.raises(QuantumAgentError) as e:
        build("ghz", 1)
    assert e.value.code == "width_out_of_range"


def test_qasm2_is_accepted():
    qc = load_qasm(
        'OPENQASM 2.0;\ninclude "qelib1.inc";\nqreg q[1];\ncreg c[1];\nx q[0];\nmeasure q[0] -> c[0];\n'
    )
    assert classify(qc)["ideal_outcome"] == "1"
