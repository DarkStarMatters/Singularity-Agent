# PrivateDAO MCP: every tool advertises an empty input schema

**Server:** `pdao-agent-exchange` v1.4.0 at `https://agents.privatedao.org/mcp`
**Protocol:** 2025-03-26
**Observed:** 20 September 2026

## Summary

All eleven tools advertise an input schema with no properties, while requiring
arguments. An MCP client's only contract is the advertised schema, so any
automated caller — including every model-driven one — constructs an empty
argument object, gets a runtime error, and has nothing to correct against.

This is not a cosmetic documentation gap. It makes the server effectively
uncallable by a well-behaved client that has not been told out of band what to
send.

## What `tools/list` returns

Every entry has this shape:

```json
{
  "name": "register_agent",
  "description": "PrivateDAO register_agent",
  "inputSchema": { "type": "object", "additionalProperties": false }
}
```

Two problems compound:

1. **`properties` is absent**, so nothing names an argument.
2. **`additionalProperties: false`** is the stronger statement — read literally,
   it says the tool accepts an object with *no* properties at all. A client that
   validates outgoing arguments against the advertised schema (a reasonable
   thing to do) will refuse to send the very fields the server needs.

The descriptions repeat the tool name (`"PrivateDAO register_agent"`), so they
carry no recoverable information either.

## What the tools actually require

Recovered by calling each with `{}` and reading the error. Quoted verbatim:

| Tool | Response to `{}` |
| --- | --- |
| `verify_basic` | `mint or record is required` |
| `create_paid_job` | `unknown service` |
| `submit_payment` | `{"status":"use_http_payment_endpoint","required":["job_id","signature"]}` |
| `job_status` | `The provided key element does not match the schema` |
| `get_receipt` | `The provided key element does not match the schema` |
| `register_agent` | `Invalid URL` |
| `logistics_request` | `capability is required` |
| `pdao_services` | succeeds — takes no arguments |
| `network_stats` | succeeds — takes no arguments |
| `search_agents` | succeeds — returns `{"agents":[]}` |
| `agent_match` | succeeds — returns `{"matches":[]}` |

`verify_basic` called with a real mint returns a full result, so the tools work.
Only their self-description is missing.

## A second issue: errors return HTTP 200 outside the JSON-RPC envelope

Tool failures come back as a bare object with a 200 status:

```json
{ "error": "request_failed", "message": "mint or record is required" }
```

rather than as a JSON-RPC error object, or as an MCP tool result with
`isError: true`. A client that checks `response.error.code` per the JSON-RPC
spec, or `result.isError` per MCP, sees neither and may read the failure as a
success with an unexpected body.

## Blocking issue: `register_agent` rejects every input with "Invalid URL"

Unlike the schema problem above, this one cannot be worked around by probing.
`register_agent` returns the same error for **every** argument shape tried,
including URLs that are syntactically valid and live:

| Arguments sent | Response |
| --- | --- |
| `{}` | `Invalid URL` |
| `{"url":"not-a-url"}` | `Invalid URL` |
| `{"url":"https://example.invalid/mcp"}` | `Invalid URL` |
| `{"url":"https://singularity-agent.cicada71.net/mcp"}` | `Invalid URL` |
| `{"url":"https://singularity-agent.cicada71.net"}` | `Invalid URL` |
| `{"endpoint":…}`, `{"agent_url":…}`, `{"mcp_url":…}`, `{"agentUrl":…}`, `{"uri":…}` | `Invalid URL` |
| `{"agent":{"url":…,"name":…}}` | `Invalid URL` |
| with `name`, `description`, `protocol`, `capability` added | `Invalid URL` |

The response does not vary with the input, which suggests the failure happens
before the arguments are read — a `new URL(...)` over a server-side value that
is undefined, rather than over anything the caller sent.

Two things rule out a caller mistake. A syntactically valid URL and an invalid
string produce the identical error, so nothing is being parsed from the request.
And `logistics_request` accepts `{"capability":"blockchain.read"}` and returns a
created record, so the server is not failing wholesale — this tool is.

The practical effect: **no agent can be registered.** `search_agents` returns
`{"agents":[]}` and stays empty, and `logistics_request` accordingly matches
`candidates: []`, so the exchange cannot broker work to anyone.

The endpoint we would register is live and serves MCP with full schemas:

```bash
curl -s -X POST https://singularity-agent.cicada71.net/mcp   -H 'content-type: application/json'   -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Happy to retry registration as soon as the tool accepts input.

## Suggested fix

Publish real schemas in `tools/list`. For example:

```json
{
  "name": "verify_basic",
  "description": "Verify a Solana mint or a supplied evidence record. Returns a canonical digest and a receipt.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "mint": { "type": "string", "description": "Solana mint address." },
      "record": { "type": "object", "description": "JSON evidence to verify instead of a mint." }
    },
    "anyOf": [{ "required": ["mint"] }, { "required": ["record"] }],
    "additionalProperties": false
  }
}
```

And return failures either as JSON-RPC errors or as MCP tool results with
`isError: true`, so a client can tell success from failure without string
matching.

## How this affects callers today

`src/exchange/privatedao.ts` in this repository talks to the exchange with the
argument shapes above, derived from error messages rather than from the server.
That client carries `checkSchemaDrift()`, which reports how many tools now
advertise properties — when that number stops being zero, the guesswork gets
deleted and the client is rewritten against the published schemas.

Happy to test against a fix.
