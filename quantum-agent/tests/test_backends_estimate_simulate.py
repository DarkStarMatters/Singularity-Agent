import pytest

from quantum_agent import backends
from quantum_agent.circuits import build, load_qasm
from quantum_agent.envelope import QuantumAgentError
from quantum_agent.estimate import estimate
from quantum_agent.simulate import shape_counts, simulate


def test_missing_credentials_is_an_error_not_an_empty_list():
    with pytest.raises(QuantumAgentError) as e:
        backends.list_ibm()
    assert e.value.code == "ibm_credentials_missing"


def test_fake_backends_are_listed_and_filtered():
    rows = backends.list_fake()
    assert len(rows) > 10
    assert all(r["name"].startswith("fake_") for r in rows)
    wide = backends.list_fake(min_qubits=100)
    assert wide and all(r["qubits"] >= 100 for r in wide)


def test_fake_source_says_it_is_a_snapshot():
    _, src = backends.get_backend("fake_fez")
    assert src.kind == "fake_backend_snapshot"
    assert "recorded 20" in src.detail


def test_calibration_hash_is_stable_and_covers_every_qubit():
    b, _ = backends.get_backend("fake_fez")
    a, c = backends.calibration(b), backends.calibration(b, [0, 155])
    assert a["calibration_hash"] == c["calibration_hash"]
    assert a["calibration_hash"].startswith("sha3-256:")
    assert len(backends.snapshot(b)["qubits"]) == 156
    assert [q["qubit"] for q in c["qubits"]] == [0, 155]
    assert a["summary"]["two_qubit_gate"] == "cz"


def test_calibration_hashes_differ_between_devices():
    fez, _ = backends.get_backend("fake_fez")
    sher, _ = backends.get_backend("fake_sherbrooke")
    assert backends.calibration(fez)["calibration_hash"] != backends.calibration(sher)["calibration_hash"]


def test_calibration_rejects_missing_qubits():
    b, _ = backends.get_backend("fake_fez")
    with pytest.raises(QuantumAgentError) as e:
        backends.calibration(b, [156])
    assert e.value.code == "qubit_out_of_range"


def test_unknown_fake_backend():
    with pytest.raises(QuantumAgentError) as e:
        backends.get_backend("fake_nowhere")
    assert e.value.code == "unknown_backend"


def test_estimate_is_deterministic_and_bounded():
    qc, _ = build("mirror", 5, 4, 3)
    b, _ = backends.get_backend("fake_fez")
    first, second = estimate(qc, b, 4000), estimate(qc, b, 4000)
    assert first == second
    assert 0 < first["estimated_success_probability"] < 1
    assert first["qpu_seconds_lower_bound"] == pytest.approx(first["circuit_duration_s"] * 4000)
    assert len(first["physical_qubits"]) == 5


def test_estimate_refuses_a_circuit_wider_than_the_device():
    qc, _ = build("ghz", 30)
    b, _ = backends.get_backend("fake_manila")
    with pytest.raises(QuantumAgentError) as e:
        estimate(qc, b, 100)
    assert e.value.code == "circuit_too_wide"


def test_ideal_mirror_simulation_hits_the_ideal_outcome_every_shot():
    qc, meta = build("mirror", 6, 5, 9)
    out = simulate(qc, 500, seed=1)
    assert out["counts"] == {meta["ideal_outcome"]: 500}
    assert out["completeness"]["kind"] == "exhaustive"


def test_wide_clifford_simulates_via_stabilizer():
    qc, meta = build("mirror", 80, 2, 4)
    out = simulate(qc, 50, seed=1)
    assert out["method"] == "stabilizer"
    assert out["counts"] == {meta["ideal_outcome"]: 50}


def test_noisy_simulation_is_reproducible_and_imperfect():
    qc, meta = build("mirror", 5, 6, 2)
    b, _ = backends.get_backend("fake_fez")
    a, c = simulate(qc, 2000, 5, noise_backend=b), simulate(qc, 2000, 5, noise_backend=b)
    assert a["counts"] == c["counts"]
    assert 1000 < a["counts"].get(meta["ideal_outcome"], 0) < 2000


def test_shape_counts_says_when_it_cuts():
    counts = {format(i, "08b"): 100 - i for i in range(50)}
    shots = sum(counts.values())
    out = shape_counts(counts, shots, top=10)
    assert len(out["counts"]) == 10
    assert out["completeness"]["kind"] == "truncated"
    assert (out["completeness"]["shown"], out["completeness"]["omitted"]) == (10, 40)
    assert str(shots - sum(out["counts"].values())) in out["completeness"]["note"]


def test_wide_non_clifford_simulation_is_refused():
    body = "".join(f"rx(0.3) q[{i}];\n" for i in range(30))
    qc = load_qasm(
        'OPENQASM 3.0;\ninclude "stdgates.inc";\nbit[30] c;\nqubit[30] q;\n' + body + "c = measure q;\n"
    )
    with pytest.raises(QuantumAgentError) as e:
        simulate(qc, 10, 0)
    assert e.value.code == "simulation_too_wide"
