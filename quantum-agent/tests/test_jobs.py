from qiskit_aer.primitives import SamplerV2

from quantum_agent.circuits import build
from quantum_agent.jobs import extract_counts


def test_extract_counts_reads_a_real_sampler_v2_result():
    qc, meta = build("mirror", 4, 3, 1)
    result = SamplerV2(seed=3).run([qc], shots=200).result()
    assert extract_counts(result) == {"meas": {meta["ideal_outcome"]: 200}}
