/**
 * Singularity's MCP surface, over HTTP.
 *
 * Until now the server spoke only stdio, which means it could be used by a
 * host willing to spawn a local process and by nobody else. That rules out
 * every agent platform that connects to a *URL* — including the PrivateDAO
 * exchange, which registers agents by endpoint and has nothing to call
 * otherwise.
 *
 * So the same twenty-one tools are served here, from the same catalogue. That
 * sharing is the point rather than a convenience: two hand-maintained tool
 * lists drift, and the one that drifts silently is the one nobody runs
 * locally.
 *
 * ## Why this speaks JSON-RPC directly
 *
 * The MCP SDK's HTTP transport wants Node request and response streams and a
 * session it can keep between calls. A serverless function has neither — every
 * invocation is a fresh process with no memory of the last — so the transport
 * would be carrying machinery for a thing that cannot happen here. The protocol
 * itself is small, and the subset a stateless server needs is smaller: four
 * methods, none of which require state.
 *
 * Not importing the SDK has a second benefit this deployment paid for already.
 * A handler here once failed to load at all, and the probes that diagnosed it
 * bisected by import weight. A tool endpoint that pulls
 * in the whole SDK is a tool endpoint that fails the same way.
 *
 * ## What it will not do
 *
 * Read-only, exactly as the stdio server is. `build_transfer` and `build_burn`
 * return unsigned payloads; nothing here signs, and no key reaches this
 * process. Being reachable over HTTP widens *who can ask*, and changes nothing
 * about what can be done.
 */

import { TOOLS, getTool } from '../src/tools/catalog.js';
import { shapeToJsonSchema } from '../src/tools/json-schema.js';
import { SingularityError } from '../src/core/errors.js';
import { VERSION } from '../src/version.js';

/**
 * The protocol version this speaks.
 *
 * Echoed back rather than negotiated: a stateless server has no session in
 * which a negotiated version could mean anything, and every method used here
 * is stable across the revisions in circulation.
 */
const PROTOCOL_VERSION = '2025-06-18';

const INSTRUCTIONS = [
  'Singularity is a read-only, multi-chain blockchain client covering EVM, Solana, Bitcoin/UTXO and Cosmos.',
  '',
  'It holds no private keys and cannot sign or broadcast. `build_transfer` returns an UNSIGNED payload for the user to sign in their own wallet — always show the summary and warnings to the user before they sign.',
  '',
  'Start with `resolve` when you are handed a bare string: it identifies whether it is an address, a transaction hash, or a name, and which chains it could belong to. `chains` lists everything supported.',
  '',
  'Balances are returned without fiat pricing. On EVM chains, token lists cover a curated set of major tokens — never present them as a complete holdings list.',
].join('\n');

interface Request {
  method?: string;
  body?: unknown;
  headers?: Record<string, string | string[] | undefined>;
}

interface Response {
  status(code: number): Response;
  setHeader(name: string, value: string): void;
  json(body: unknown): void;
  end(): void;
}

function cors(res: Response): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Mcp-Session-Id, MCP-Protocol-Version');
  // Every tool here reads live chain state. A cached answer to "what is this
  // balance" is the failure this project spends most of its effort avoiding.
  res.setHeader('Cache-Control', 'no-store');
}

/** A JSON-RPC error, in the shape the spec requires. */
function rpcError(id: unknown, code: number, message: string, data?: unknown): unknown {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data ? { data } : {}) } };
}

function rpcResult(id: unknown, result: unknown): unknown {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

/**
 * The tool list, with real schemas.
 *
 * Worth stating plainly because the exchange this endpoint exists to talk to
 * does the opposite. The count in the next line is theirs, not ours, which is
 * why it carries a marker: tool-count:ignore
 * It advertises eleven tools with empty schemas that accept
 * no properties, while requiring arguments. A client — human or model — has
 * then no way to construct a valid call except by guessing and reading the
 * error. Every tool here carries its full parameter schema, derived from the
 * same Zod definitions the CLI validates against.
 */
function toolList(): unknown {
  return {
    tools: TOOLS.map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: shapeToJsonSchema(tool.shape),
      annotations: tool.annotations,
    })),
  };
}

/** Text content holding pretty JSON, matching the stdio server exactly. */
function toolResult(value: unknown, isError = false): unknown {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

async function callTool(params: unknown): Promise<unknown> {
  const { name, arguments: args } = (params ?? {}) as {
    name?: string;
    arguments?: Record<string, unknown>;
  };

  if (!name) return toolResult({ error: 'BAD_INPUT', message: 'A tool call needs a name.' }, true);

  const tool = getTool(name);

  // Refused by name rather than ignored. A model can name a tool it was never
  // offered, and an empty result there reads as "nothing found" instead of
  // "that does not exist".
  if (!tool) {
    return toolResult(
      {
        error: 'TOOL_NOT_AVAILABLE',
        message: `No tool named "${name}".`,
        hint: `Available: ${TOOLS.map((t) => t.name).join(', ')}.`,
      },
      true,
    );
  }

  try {
    return toolResult(await tool.run(args ?? {}));
  } catch (err) {
    // Errors come back as results rather than transport failures, so the caller
    // can correct itself instead of stalling on something it cannot see into.
    const payload =
      err instanceof SingularityError
        ? { error: err.code, message: err.message, hint: err.hint }
        : { error: 'UNEXPECTED', message: err instanceof Error ? err.message : String(err) };

    return toolResult(payload, true);
  }
}

export default async function handler(req: Request, res: Response): Promise<void> {
  cors(res);

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  // A GET asking for a stream is the one case where 405 is the right answer:
  // the spec lets a server decline server-initiated SSE, and saying so plainly
  // is how a client learns to stop asking.
  if (req.method === 'GET' || req.method === 'HEAD') {
    const accept = String(req.headers?.['accept'] ?? '');

    if (accept.includes('text/event-stream')) {
      res.status(405).json(
        rpcError(null, -32600, 'This endpoint does not offer a server-initiated SSE stream. POST JSON-RPC instead.'),
      );
      return;
    }

    // Everything else that arrives by GET is a health check, a registry
    // crawler or a person pasting the URL into a browser. All three want to
    // know the endpoint is alive and what it is, and all three read a 405 as a
    // failure — which is how a working server gets reported as broken.
    res.status(200).json({
      name: 'singularity-agent',
      version: VERSION,
      protocol: 'mcp',
      protocolVersion: PROTOCOL_VERSION,
      transport: 'http-jsonrpc',
      tools: TOOLS.length,
      readOnly: true,
      usage: 'POST JSON-RPC 2.0 here: initialize, tools/list, tools/call.',
    });
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json(
      rpcError(null, -32600, 'This endpoint speaks JSON-RPC over POST. Send an MCP request.'),
    );
    return;
  }

  const body = typeof req.body === 'string' ? safeParse(req.body) : req.body;

  if (!body || typeof body !== 'object') {
    res.status(400).json(rpcError(null, -32700, 'Request body was not JSON.'));
    return;
  }

  // A batch is a JSON array. Handled because the spec allows it and a client
  // that sends one should not get a parse error back.
  if (Array.isArray(body)) {
    const results = await Promise.all(body.map((entry) => dispatch(entry)));
    res.status(200).json(results.filter((entry) => entry !== null));
    return;
  }

  const result = await dispatch(body);

  // A notification has no id and takes no response. 202 with no body is what
  // the spec asks for, and returning a result instead makes a client wait for
  // a reply to something it did not ask a question about.
  if (result === null) {
    res.status(202).end();
    return;
  }

  res.status(200).json(result);
}

async function dispatch(message: unknown): Promise<unknown | null> {
  const { id, method, params } = (message ?? {}) as {
    id?: unknown;
    method?: string;
    params?: unknown;
  };

  const isNotification = id === undefined || id === null;

  switch (method) {
    case 'initialize':
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        serverInfo: { name: 'singularity-agent', version: VERSION },
        capabilities: { tools: { listChanged: false } },
        instructions: INSTRUCTIONS,
      });

    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null;

    case 'ping':
      return isNotification ? null : rpcResult(id, {});

    case 'tools/list':
      return rpcResult(id, toolList());

    case 'tools/call':
      return rpcResult(id, await callTool(params));

    // Declared unsupported rather than left to time out. A client that asks for
    // resources gets a clear answer on the first call.
    case 'resources/list':
    case 'prompts/list':
      return rpcError(id, -32601, `Singularity exposes tools only; "${method}" is not supported.`);

    default:
      return isNotification
        ? null
        : rpcError(id, -32601, `Unknown method "${method ?? '(none)'}".`);
  }
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
