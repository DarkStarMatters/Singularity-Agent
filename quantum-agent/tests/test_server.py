"""The server over its real transport: a subprocess speaking MCP on stdio."""

import json
import os
import sys

import anyio
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

# Every tool the server exposes. A tool that submits or cancels jobs must not
# appear here without the gate the server docstring promises.
EXPECTED_TOOLS = {
    "backends",
    "calibration",
    "usage",
    "job",
    "build_circuit",
    "classify_circuit",
    "estimate",
    "simulate",
    "verify_result",
}


def run(fn):
    async def go():
        params = StdioServerParameters(
            command=sys.executable, args=["-m", "quantum_agent.server"], env=dict(os.environ)
        )
        async with stdio_client(params) as (read, write):
            async with ClientSession(read, write) as session:
                await session.initialize()
                return await fn(session)

    return anyio.run(go)


def payload(result):
    assert not result.is_error, result.content[0].text
    return json.loads(result.content[0].text)


def test_tool_list_is_pinned_and_read_only():
    async def go(s):
        return (await s.list_tools()).tools

    tools = run(go)
    assert {t.name for t in tools} == EXPECTED_TOOLS
    assert all(t.annotations and t.annotations.read_only_hint for t in tools)


def test_build_classify_simulate_end_to_end():
    async def go(s):
        built = payload(await s.call_tool("build_circuit", {"template": "mirror", "qubits": 4, "seed": 5}))
        cls = payload(await s.call_tool("classify_circuit", {"qasm": built["qasm"]}))
        sim = payload(await s.call_tool("simulate", {"qasm": built["qasm"], "shots": 100}))
        return built, cls, sim

    built, cls, sim = run(go)
    assert cls["commitment"] == built["commitment"]
    assert cls["class"] == "deterministic"
    assert sim["counts"] == {built["template"]["ideal_outcome"]: 100}
    assert sim["source"]["kind"] == "local"


def test_errors_arrive_as_tool_errors_with_a_code():
    async def go(s):
        return await s.call_tool("backends", {"source": "ibm"})

    result = run(go)
    assert result.is_error
    assert "ibm_credentials_missing" in result.content[0].text


def test_noisy_simulation_refuses_live_backends():
    async def go(s):
        built = payload(await s.call_tool("build_circuit", {"template": "bell"}))
        return await s.call_tool("simulate", {"qasm": built["qasm"], "noise_backend": "ibm_fez"})

    result = run(go)
    assert result.is_error and "noise_backend_not_fake" in result.content[0].text


def test_verify_result_scores_a_simulated_run():
    async def go(s):
        built = payload(await s.call_tool("build_circuit", {"template": "mirror", "qubits": 6, "seed": 3}))
        ideal = built["template"]["ideal_outcome"]
        return built, payload(
            await s.call_tool(
                "verify_result",
                {"qasm": built["qasm"], "counts": {ideal: 95, "0" * 6: 5}, "threshold_ppm": 900_000},
            )
        )

    built, r = run(go)
    assert r["commitment"] == built["commitment"]
    assert r["verdict"] == "pass" and r["score"]["ppm"] == 950_000
    assert r["labels"]["result_is_correct"] == "verified_implementation"


def test_verify_result_needs_exactly_one_of_counts_and_job():
    async def go(s):
        built = payload(await s.call_tool("build_circuit", {"template": "bell"}))
        return await s.call_tool("verify_result", {"qasm": built["qasm"]})

    result = run(go)
    assert result.is_error and "counts_or_job" in result.content[0].text
