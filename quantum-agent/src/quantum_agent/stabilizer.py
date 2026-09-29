"""
Where a Clifford circuit's measured outcomes can land, as parity constraints.

Measuring a stabilizer state in the Z basis gives outcomes spread uniformly over
an affine subspace of bitstrings, and that subspace is fixed by the stabilizers
that are Z-only on the measured qubits: each one, with sign (-1)^p, says the
parity of the bits it touches is p. An outcome outside the subspace has ideal
probability zero, so a shot that lands there is an error, at any width.

The arithmetic is Aaronson–Gottesman's (quant-ph/0406196): tableau rows combined
with `rowsum`, phases tracked mod 4 with integers. Nothing here uses a float,
because Tessarq's Q2 verifier will do the same on-chain in Rust and the two have
to agree bit for bit. The constraints are returned in reduced row echelon form
over classical bits, which is unique for a given subspace, so two
implementations can compare them directly rather than comparing bases.
"""

from __future__ import annotations

from dataclasses import dataclass

from qiskit.quantum_info import Clifford


@dataclass(frozen=True)
class Constraint:
    """The bits named in `mask` (bit c is classical bit c) have XOR equal to `parity`."""

    mask: int
    parity: int

    def bits(self) -> list[int]:
        return [c for c in range(self.mask.bit_length()) if self.mask >> c & 1]

    def holds(self, value: int) -> bool:
        return (value & self.mask).bit_count() % 2 == self.parity

    def to_dict(self) -> dict:
        return {"bits": self.bits(), "parity": self.parity}


def _g(x1: int, z1: int, x2: int, z2: int) -> int:
    """The power of i picked up when Pauli (x1,z1) multiplies (x2,z2) on one qubit."""
    if x1 == 0 and z1 == 0:
        return 0
    if x1 == 1 and z1 == 1:
        return z2 - x2
    if x1 == 1:
        return z2 * (2 * x2 - 1)
    return x2 * (1 - 2 * z2)


def _rowsum(rows: list[list[int]], h: int, i: int, n: int) -> None:
    """Row h becomes row i times row h. A row is [x_0..x_{n-1}, z_0..z_{n-1}, r]."""
    a, b = rows[i], rows[h]
    total = 2 * b[2 * n] + 2 * a[2 * n]
    for j in range(n):
        total += _g(a[j], a[n + j], b[j], b[n + j])
    total %= 4
    # Stabilizers commute, so the product is Hermitian and its phase is +1 or -1.
    assert total in (0, 2), "tableau rows do not commute"
    b[2 * n] = total // 2
    for j in range(2 * n):
        b[j] ^= a[j]


def z_constraints(clifford: Clifford, measured: dict[int, int], num_clbits: int) -> list[Constraint]:
    """
    The constraints every ideal outcome satisfies, over classical bits.

    `measured` maps each measured qubit to the one classical bit it is written
    to. A classical bit nothing writes reads 0, so it gets the constraint
    "this bit is 0" like any other.
    """
    n = clifford.num_qubits
    rows = [
        [int(v) for v in clifford.stab_x[k]] + [int(v) for v in clifford.stab_z[k]] + [int(clifford.stab_phase[k])]
        for k in range(n)
    ]

    # Clear every X column, and the Z column of every unmeasured qubit. Rows left
    # with none of those set are the stabilizers that are Z-only on measured qubits.
    clear = list(range(n)) + [n + q for q in range(n) if q not in measured]
    free = set(range(n))
    for col in clear:
        pivot = next((k for k in sorted(free) if rows[k][col]), None)
        if pivot is None:
            continue
        free.discard(pivot)
        for k in range(n):
            if k != pivot and rows[k][col]:
                _rowsum(rows, k, pivot, n)

    found: list[Constraint] = []
    for k in sorted(free):
        mask = 0
        for q, c in measured.items():
            if rows[k][n + q]:
                mask |= 1 << c
        if mask:
            found.append(Constraint(mask, rows[k][2 * n]))

    written = set(measured.values())
    found.extend(Constraint(1 << c, 0) for c in range(num_clbits) if c not in written)
    return rref(found, num_clbits)


def rref(constraints: list[Constraint], num_bits: int) -> list[Constraint]:
    """
    Reduced row echelon form, pivoting on the lowest bit first.

    Unique for the subspace the constraints describe, so it is the form that
    gets compared across implementations. A dependent constraint vanishes; a
    contradictory one (0 = 1) is an error, because no ideal outcome exists.
    """
    work = [[c.mask, c.parity] for c in constraints]
    out: list[list[int]] = []
    for bit in range(num_bits):
        pivot = next((row for row in work if row[0] >> bit & 1), None)
        if pivot is None:
            continue
        work.remove(pivot)
        for row in work + out:
            if row[0] >> bit & 1:
                row[0] ^= pivot[0]
                row[1] ^= pivot[1]
        out.append(pivot)
    if any(mask == 0 and parity == 1 for mask, parity in work):
        raise ValueError("contradictory constraints: no outcome satisfies them")
    return [Constraint(mask, parity) for mask, parity in out]
