"""
ThinLine evidence labels, as Tessarq defines them.

Mirrors `crates/tessarq-core/src/thinline.rs` in the Quantum-Chain repository,
including the strength ordering, so a label computed here means the same thing
when it reaches the chain. `tests/test_thinline.py` pins the values.
"""

from __future__ import annotations

from enum import Enum


class EvidenceLabel(str, Enum):
    EMPIRICALLY_SUPPORTED = "empirically_supported"
    REPRODUCED_RESULT = "reproduced_result"
    VERIFIED_IMPLEMENTATION = "verified_implementation"
    PRELIMINARY = "preliminary"
    HYPOTHETICAL = "hypothetical"
    SPECULATIVE = "speculative"
    SYMBOLIC = "symbolic"
    REJECTED = "rejected"

    @property
    def strength(self) -> int:
        return _STRENGTH[self]

    @property
    def self_declarable(self) -> bool:
        """Whether a submitter may put this on its own record without attestation."""
        return self.strength <= _STRENGTH[EvidenceLabel.PRELIMINARY] and self is not EvidenceLabel.REJECTED


_STRENGTH = {
    EvidenceLabel.EMPIRICALLY_SUPPORTED: 7,
    EvidenceLabel.REPRODUCED_RESULT: 6,
    EvidenceLabel.VERIFIED_IMPLEMENTATION: 5,
    EvidenceLabel.PRELIMINARY: 4,
    EvidenceLabel.HYPOTHETICAL: 3,
    EvidenceLabel.SPECULATIVE: 2,
    EvidenceLabel.SYMBOLIC: 1,
    EvidenceLabel.REJECTED: 0,
}


def weakest(*labels: EvidenceLabel) -> EvidenceLabel:
    """The label a combined claim can carry: never stronger than its weakest part."""
    return min(labels, key=lambda label: label.strength)
