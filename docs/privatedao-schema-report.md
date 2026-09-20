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
