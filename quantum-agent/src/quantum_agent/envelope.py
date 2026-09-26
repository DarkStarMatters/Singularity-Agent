"""
What a result says about itself.

This is Singularity's answer envelope (`src/core/envelope.ts`) carried over to
quantum. The failure it exists to prevent is the same one: a result that is
partial but reads as complete. A backend list that came back empty because the
credentials were missing is not a list of zero backends, and a histogram cut to
its top outcomes is not the distribution.

So completeness is a value that has to be stated, and a failed read raises a
structured error. It never becomes an empty result.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Literal

CompletenessKind = Literal["exhaustive", "curated", "truncated", "failed"]


def exhaustive(note: str) -> dict[str, Any]:
    """This is genuinely all of it, so an empty result may be read as "there is nothing"."""
    return {"kind": "exhaustive", "note": note}


def curated(note: str) -> dict[str, Any]:
    """A known subset was checked. Absence is not evidence."""
    return {"kind": "curated", "note": note}


def truncated(shown: int, omitted: int, note: str) -> dict[str, Any]:
    """More existed than was returned, and both counts are known."""
    return {"kind": "truncated", "note": note, "shown": shown, "omitted": omitted}


class QuantumAgentError(Exception):
    """
    A structured failure: a stable `code` a caller can branch on, a message for
    a person, and a hint saying what would make the call succeed.
    """

    def __init__(self, code: str, message: str, hint: str | None = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.hint = hint

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {"code": self.code, "message": self.message}
        if self.hint:
            out["hint"] = self.hint
        return out

    def to_json(self) -> str:
        return json.dumps(self.to_dict())


@dataclass(frozen=True)
class Source:
    """
    Where an answer came from, and how much weight it can bear.

    `kind` separates hardware, a recorded snapshot of hardware, and this machine:
    a fake backend's calibration is real data from a real device on the date it
    was recorded, and it is never a statement about that device today.
    """

    kind: Literal["ibm_quantum", "fake_backend_snapshot", "local"]
    detail: str

    def to_dict(self) -> dict[str, str]:
        return {"kind": self.kind, "detail": self.detail}


LOCAL = Source("local", "computed on this machine; nothing was sent anywhere")
