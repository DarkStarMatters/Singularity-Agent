import json

from quantum_agent.commit import circuit_commitment
from quantum_agent.vectors import PATH, render


def test_committed_vectors_match_the_verifiers():
    assert PATH.read_text(encoding="utf-8") == render(), (
        "vectors/verify-v1.json is stale: run `uv run python -m quantum_agent.vectors`. "
        "If a verdict changed, that is a change Tessarq's Rust verifiers must make too."
    )


def test_vectors_cover_every_method_and_both_verdicts():
    cases = json.loads(PATH.read_text(encoding="utf-8"))["cases"]
    methods = {c["expected"].get("method") for c in cases}
    verdicts = {c["expected"].get("verdict") for c in cases}
    assert {"success_probability", "stabilizer_support", "hellinger_fidelity"} <= methods
    assert {"pass", "fail", "not_judged"} <= verdicts
    assert any("error" in c["expected"] for c in cases)
    for c in cases:
        assert c["commitment"] == circuit_commitment(c["qasm"])
