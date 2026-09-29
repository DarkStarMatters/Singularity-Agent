"""
Reading jobs and usage from IBM Quantum. Reading only: nothing here submits,
cancels or deletes a job.
"""

from __future__ import annotations

from typing import Any

from .backends import ibm_service
from .envelope import QuantumAgentError
from .simulate import shape_counts


def extract_counts(result) -> dict[str, dict[str, int]]:
    """
    Counts per classical register from a Sampler V2 result's first pub.

    Keyed by register name, because a circuit with two registers has two
    histograms and merging them would invent a joint distribution.
    """
    try:
        data = result[0].data
    except Exception as exc:
        raise QuantumAgentError(
            "result_unrecognised",
            "The job result is not a Sampler V2 result, so no counts could be read from it.",
        ) from exc
    counts: dict[str, dict[str, int]] = {}
    for name in data:
        field = data[name]
        if hasattr(field, "get_counts"):
            counts[name] = field.get_counts()
    if not counts:
        raise QuantumAgentError("result_unrecognised", "The job result holds no measured registers.")
    return counts


def job(job_id: str) -> dict[str, Any]:
    service = ibm_service()
    try:
        j = service.job(job_id)
    except Exception as exc:
        raise QuantumAgentError("job_not_found", f"IBM Quantum has no job {job_id!r} visible here: {exc}") from exc

    status = j.status()
    status = getattr(status, "name", status)
    out: dict[str, Any] = {"job_id": job_id, "status": str(status)}
    try:
        out["backend"] = j.backend().name
    except Exception:
        pass
    created = getattr(j, "creation_date", None)
    if created is not None:
        out["created"] = created.isoformat()
    try:
        out["usage_seconds"] = j.usage()
    except Exception:
        pass

    if str(status) != "DONE":
        out["note"] = "Counts are read only from finished jobs."
        return out

    registers = extract_counts(j.result())
    shots = sum(next(iter(registers.values())).values())
    out["shots"] = shots
    out["registers"] = {name: shape_counts(c, shots) for name, c in registers.items()}
    out["provenance_note"] = (
        "Backend, status and counts are IBM's record of this job. That the job ran on that "
        "backend rests on IBM's word: the `ran_on_claimed_qpu` ceiling is `preliminary`."
    )
    return out


def full_counts(job_id: str) -> tuple[dict[str, int], str | None]:
    """
    The complete histogram of a finished single-register job, for verification.

    `job` cuts its histograms to the top outcomes, which is right for reading and
    wrong for scoring: a score over a cut histogram is a score over the part
    that was kept. This returns every outcome, or refuses.
    """
    service = ibm_service()
    try:
        j = service.job(job_id)
    except Exception as exc:
        raise QuantumAgentError("job_not_found", f"IBM Quantum has no job {job_id!r} visible here: {exc}") from exc
    status = j.status()
    status = str(getattr(status, "name", status))
    if status != "DONE":
        raise QuantumAgentError("job_not_done", f"Job {job_id} is {status}; only finished jobs have counts to verify.")
    registers = extract_counts(j.result())
    if len(registers) != 1:
        raise QuantumAgentError(
            "counts_multiple_registers",
            f"Job {job_id} measured into {len(registers)} registers: {', '.join(registers)}.",
            "Verification reads one register; measure into a single register.",
        )
    try:
        backend = j.backend().name
    except Exception:
        backend = None
    return next(iter(registers.values())), backend


def usage() -> dict[str, Any]:
    service = ibm_service()
    try:
        data = service.usage()
    except Exception as exc:
        raise QuantumAgentError("ibm_unreachable", f"Reading usage failed: {exc}") from exc
    return {
        "usage": data,
        "note": "As IBM reports it for the active instance; period and limits are IBM's definitions.",
    }
