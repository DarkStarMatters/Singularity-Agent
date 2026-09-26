import pytest


@pytest.fixture(autouse=True)
def no_ibm_credentials(monkeypatch, tmp_path):
    """Tests never reach IBM: no token in the environment, and no saved account on disk."""
    monkeypatch.delenv("QISKIT_IBM_TOKEN", raising=False)
    monkeypatch.delenv("QISKIT_IBM_INSTANCE", raising=False)
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("USERPROFILE", str(tmp_path))
