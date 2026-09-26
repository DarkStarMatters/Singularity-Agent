"""
Commitments: the hashes a circuit and a calibration are known by.

Tessarq hashes with SHA3-256 throughout, and its planned `QuantumJob` carries
"circuit commitment (OpenQASM 3 hash)" and "calibration hash" (ROADMAP-v0.2,
Q1). Q1 is not implemented yet, so nothing on-chain fixes the byte format these
are taken over. This module is that definition until it is, and it is written
down here so the Rust side can match it rather than rediscover it:

- **Circuit:** SHA3-256 over the OpenQASM text as UTF-8, with CRLF and lone CR
  normalised to LF. Nothing else is normalised. The commitment is to the text
  that was submitted, not to a re-export of it, because a re-export depends on
  the qiskit version that produced it and would make the same circuit hash
  differently a release later.
- **Structured data (calibration):** SHA3-256 over canonical JSON: sorted keys,
  no whitespace, UTF-8, floats in Python's shortest round-trip form. NaN and
  infinities are refused rather than encoded, because JSON has no spelling for
  them that another implementation is obliged to agree with.

Both are returned as `sha3-256:<64 hex>`, so a hash never travels without its
algorithm.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any

PREFIX = "sha3-256:"


def normalise_newlines(text: str) -> str:
    return text.replace("\r\n", "\n").replace("\r", "\n")


def circuit_commitment(qasm: str) -> str:
    return PREFIX + hashlib.sha3_256(normalise_newlines(qasm).encode("utf-8")).hexdigest()


def canonical_json(value: Any) -> bytes:
    return json.dumps(
        value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False
    ).encode("utf-8")


def data_commitment(value: Any) -> str:
    return PREFIX + hashlib.sha3_256(canonical_json(value)).hexdigest()
