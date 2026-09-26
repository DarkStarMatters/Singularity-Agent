import hashlib

import pytest

from quantum_agent.commit import canonical_json, circuit_commitment, data_commitment
from quantum_agent.thinline import EvidenceLabel, weakest


def test_strengths_match_tessarq():
    # crates/tessarq-core/src/thinline.rs, EvidenceLabel::strength
    assert {label.value: label.strength for label in EvidenceLabel} == {
        "empirically_supported": 7,
        "reproduced_result": 6,
        "verified_implementation": 5,
        "preliminary": 4,
        "hypothetical": 3,
        "speculative": 2,
        "symbolic": 1,
        "rejected": 0,
    }


def test_self_declarable_matches_tessarq():
    declarable = {label.value for label in EvidenceLabel if label.self_declarable}
    assert declarable == {"preliminary", "hypothetical", "speculative", "symbolic"}


def test_weakest():
    assert (
        weakest(EvidenceLabel.VERIFIED_IMPLEMENTATION, EvidenceLabel.PRELIMINARY)
        is EvidenceLabel.PRELIMINARY
    )


def test_circuit_commitment_is_sha3_of_lf_text():
    text = 'OPENQASM 3.0;\ninclude "stdgates.inc";\n'
    assert circuit_commitment(text) == "sha3-256:" + hashlib.sha3_256(text.encode()).hexdigest()
    assert circuit_commitment(text.replace("\n", "\r\n")) == circuit_commitment(text)
    assert circuit_commitment(text + " ") != circuit_commitment(text)


def test_known_vectors():
    # Pinned so another implementation (Tessarq's Rust side) can check itself against them.
    assert circuit_commitment("") == (
        "sha3-256:a7ffc6f8bf1ed76651c14756a061d662f580ff4de43b49fa82d80a4b80f8434a"
    )
    assert canonical_json({"b": 1, "a": [1.5, None, "é"]}) == '{"a":[1.5,null,"é"],"b":1}'.encode()


def test_data_commitment_refuses_nan():
    with pytest.raises(ValueError):
        data_commitment({"t1": float("nan")})
