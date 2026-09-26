"""The version lives in four places. They drift apart silently unless something checks."""

import json
import tomllib
from pathlib import Path

from quantum_agent import __version__

PLUGIN = Path(__file__).resolve().parents[1]
REPO = PLUGIN.parent


def test_every_manifest_carries_the_package_version():
    pyproject = tomllib.loads((PLUGIN / "pyproject.toml").read_text(encoding="utf-8"))
    plugin = json.loads((PLUGIN / ".claude-plugin" / "plugin.json").read_text(encoding="utf-8"))
    marketplace = json.loads((REPO / ".claude-plugin" / "marketplace.json").read_text(encoding="utf-8"))
    entry = next(p for p in marketplace["plugins"] if p["name"] == "quantum-agent")

    assert pyproject["project"]["version"] == __version__
    assert plugin["version"] == __version__
    assert entry["version"] == __version__
    assert entry["source"] == "./quantum-agent"
