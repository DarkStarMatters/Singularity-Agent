"""
Backends: IBM Quantum hardware, and recorded snapshots of it.

Two sources, never blurred together:

- **IBM Quantum** needs credentials, which are read from the environment
  (`QISKIT_IBM_TOKEN`, `QISKIT_IBM_INSTANCE`, optional `QISKIT_IBM_CHANNEL`) or,
  failing that, from an account the operator saved with
  `QiskitRuntimeService.save_account`. They are never accepted as a tool
  argument, so a model cannot be talked into sending them anywhere.
- **Fake backends** (`fake_fez`, `fake_sherbrooke`, ...) ship with
  qiskit-ibm-runtime. They carry a real device's calibration **from the date it
  was recorded**, which every answer built on one states. They need no network
  and no credentials, so they are what tests and first runs use.

Nothing in this module submits a job.
"""

from __future__ import annotations

import os
import statistics
import warnings
from functools import lru_cache
from typing import Any

from .commit import data_commitment
from .envelope import QuantumAgentError, Source

FAKE_PREFIX = "fake_"
TWO_QUBIT_GATES = ("cz", "ecr", "cx")


def is_fake(name: str) -> bool:
    return name.startswith(FAKE_PREFIX)


@lru_cache(maxsize=1)
def _fake_provider():
    from qiskit_ibm_runtime.fake_provider import FakeProviderForBackendV2

    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        return FakeProviderForBackendV2()


def fake_backend_names() -> list[str]:
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        return sorted(b.name for b in _fake_provider().backends())


def _fake_backend(name: str):
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        try:
            return _fake_provider().backend(name)
        except Exception as exc:
            raise QuantumAgentError(
                "unknown_backend",
                f"No fake backend named {name!r}.",
                "List them with `backends` and source `fake`.",
            ) from exc


def ibm_service():
    """The runtime service, or a `ibm_credentials_missing` error. Never a silent fallback."""
    from qiskit_ibm_runtime import QiskitRuntimeService

    token = os.environ.get("QISKIT_IBM_TOKEN")
    instance = os.environ.get("QISKIT_IBM_INSTANCE")
    channel = os.environ.get("QISKIT_IBM_CHANNEL", "ibm_quantum_platform")
    try:
        if token:
            return QiskitRuntimeService(channel=channel, token=token, instance=instance)
        return QiskitRuntimeService()
    except Exception as exc:
        if not token:
            raise QuantumAgentError(
                "ibm_credentials_missing",
                "No IBM Quantum credentials: QISKIT_IBM_TOKEN is unset and no saved account loaded.",
                "Set QISKIT_IBM_TOKEN and QISKIT_IBM_INSTANCE (the instance CRN) in the environment "
                "the MCP server runs in, or use a fake backend such as `fake_fez`.",
            ) from exc
        raise QuantumAgentError(
            "ibm_unreachable",
            f"IBM Quantum refused or failed the connection: {exc}",
            "Check the token, the instance CRN and QISKIT_IBM_CHANNEL.",
        ) from exc


def get_backend(name: str):
    """A backend and the source its data comes from."""
    if is_fake(name):
        backend = _fake_backend(name)
        return backend, fake_source(backend)
    service = ibm_service()
    try:
        backend = service.backend(name)
    except Exception as exc:
        raise QuantumAgentError(
            "unknown_backend", f"IBM Quantum has no backend {name!r} visible to this instance: {exc}"
        ) from exc
    return backend, Source("ibm_quantum", f"{name}, read live from IBM Quantum")


def fake_source(backend) -> Source:
    recorded = _last_update(backend) or "an unrecorded date"
    return Source(
        "fake_backend_snapshot",
        f"{backend.name}: calibration recorded {recorded}; says nothing about the device today",
    )


def _last_update(backend) -> str | None:
    try:
        props = backend.properties()
    except Exception:
        return None
    stamp = getattr(props, "last_update_date", None) if props is not None else None
    return stamp.isoformat() if stamp is not None else None


def list_ibm(min_qubits: int | None = None) -> list[dict[str, Any]]:
    service = ibm_service()
    try:
        found = service.backends(min_num_qubits=min_qubits)
    except Exception as exc:
        raise QuantumAgentError("ibm_unreachable", f"Listing IBM backends failed: {exc}") from exc
    rows = []
    for b in found:
        row: dict[str, Any] = {"name": b.name, "qubits": b.num_qubits}
        try:
            status = b.status()
            row.update(
                operational=status.operational,
                pending_jobs=status.pending_jobs,
                status=status.status_msg,
            )
        except Exception as exc:
            row["status_error"] = str(exc)
        processor = getattr(b, "processor_type", None)
        if processor:
            row["processor"] = processor
        rows.append(row)
    return sorted(rows, key=lambda r: r["name"])


def list_fake(min_qubits: int | None = None) -> list[dict[str, Any]]:
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        rows = [
            {"name": b.name, "qubits": b.num_qubits, "recorded": _last_update(b)}
            for b in _fake_provider().backends()
        ]
    if min_qubits:
        rows = [r for r in rows if r["qubits"] >= min_qubits]
    return sorted(rows, key=lambda r: r["name"])


def _error(target, op: str, qargs) -> float | None:
    props = target[op].get(qargs) if op in target.operation_names else None
    return None if props is None else props.error


def snapshot(backend) -> dict[str, Any]:
    """
    Everything calibration-shaped about a backend, as plain data.

    This is what the calibration hash commits to, so it is built from the
    target, which real and fake backends both expose. It is deliberately
    complete: a hash over a summary would commit to the summary.
    """
    target = backend.target
    qubits = []
    for q in range(backend.num_qubits):
        qp = target.qubit_properties[q] if target.qubit_properties else None
        qubits.append(
            {
                "qubit": q,
                "t1": getattr(qp, "t1", None),
                "t2": getattr(qp, "t2", None),
                "readout_error": _error(target, "measure", (q,)),
            }
        )
    gates = {}
    for op in sorted(target.operation_names):
        entries = target[op]
        if not entries:
            continue
        rows = []
        for qargs, props in sorted(entries.items(), key=lambda kv: kv[0] or ()):
            if qargs is None or props is None:
                continue
            rows.append({"qubits": list(qargs), "error": props.error, "duration": props.duration})
        if rows:
            gates[op] = rows
    return {
        "backend": backend.name,
        "num_qubits": backend.num_qubits,
        "recorded": _last_update(backend),
        "qubits": qubits,
        "gates": gates,
    }


def _median(values: list[float | None]) -> float | None:
    present = [v for v in values if v is not None]
    return statistics.median(present) if present else None


def calibration(backend, detail_qubits: list[int] | None = None, worst: int = 5) -> dict[str, Any]:
    snap = snapshot(backend)
    qubits = snap["qubits"]
    two_q = next((g for g in TWO_QUBIT_GATES if g in snap["gates"]), None)
    two_q_errors = [row["error"] for row in snap["gates"].get(two_q, [])] if two_q else []

    by_readout = sorted(
        (q for q in qubits if q["readout_error"] is not None),
        key=lambda q: q["readout_error"],
        reverse=True,
    )
    summary = {
        "median_t1_s": _median([q["t1"] for q in qubits]),
        "median_t2_s": _median([q["t2"] for q in qubits]),
        "median_readout_error": _median([q["readout_error"] for q in qubits]),
        "two_qubit_gate": two_q,
        "median_two_qubit_error": _median(two_q_errors),
        "worst_readout_qubits": by_readout[:worst],
    }

    out: dict[str, Any] = {
        "backend": snap["backend"],
        "num_qubits": snap["num_qubits"],
        "recorded": snap["recorded"],
        "calibration_hash": data_commitment(snap),
        "hash_covers": (
            "every qubit's T1, T2 and readout error and every gate's error and duration, as "
            "canonical JSON (see commit.py). The summary below is derived from the same data."
        ),
        "summary": summary,
    }
    if detail_qubits:
        bad = [q for q in detail_qubits if not 0 <= q < snap["num_qubits"]]
        if bad:
            raise QuantumAgentError(
                "qubit_out_of_range", f"Qubits {bad} do not exist on {snap['backend']}."
            )
        out["qubits"] = [qubits[q] for q in detail_qubits]
    return out
