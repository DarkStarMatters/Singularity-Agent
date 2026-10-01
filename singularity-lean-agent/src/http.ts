/**
 * lean-link/1 over HTTP.
 *
 *   POST /call     {"v":"lean-link/1","call":Call}  →  {"v":"lean-link/1","response":Response}
 *   GET  /health   liveness
 *   GET  /info     who this node is and what it will do
 *
 * `/health` and `/info` are the names lean-worker's README gives its agent's
 * external interface, so a client that probes one kind of node can probe the
 * other. A malformed call is an HTTP 400 and never reaches the gate, so it
 * cannot spend fuel or burn a nonce.
 */
import { type IncomingMessage, type Server, createServer } from 'node:http';
import type { ClientState } from './client.js';
import { type Acceptance, accepts, mkCall } from './client.js';
import type { NodeQueue } from './node.js';
import {
  type Call,
  type Job,
  type Response,
  CallEnvelopeSchema,
  LINK_VERSION,
  ResponseEnvelopeSchema,
  UPSTREAM,
} from './wire.js';

const MAX_BODY = 64 * 1024;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export interface ServeOptions {
  queue: NodeQueue;
  /** Operator log line per call, including which gate checks a refusal failed. */
  log?: (line: string) => void;
  version: string;
}

export function createNodeServer(options: ServeOptions): Server {
  const { queue, log = () => {} } = options;

  return createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    try {
      if (req.method === 'GET' && req.url === '/health') return send(200, { ok: true, v: LINK_VERSION });
      if (req.method === 'GET' && req.url === '/info') {
        const s = queue.current();
        return send(200, {
          v: LINK_VERSION,
          id: s.id,
          agent: `singularity-lean-agent ${options.version}`,
          upstream: UPSTREAM,
          jobs: ['proveGoal', 'checkProof', ...(s.policy.allowExeCalls ? ['runExe'] : [])],
          maxFuelPerCall: s.policy.maxFuelPerCall,
          fuelRemaining: Math.max(0, s.policy.fuelBudget - s.fuelUsed),
        });
      }
      if (req.method !== 'POST' || req.url !== '/call') return send(404, { error: 'not found' });

      let parsed;
      try {
        parsed = CallEnvelopeSchema.safeParse(JSON.parse(await readBody(req)));
      } catch {
        return send(400, { error: 'body is not JSON, or is larger than 64 KiB' });
      }
      if (!parsed.success) return send(400, { error: `not a ${LINK_VERSION} call`, issues: parsed.error.issues.slice(0, 5) });

      const handled = await queue.submit(parsed.data.call);
      const { body } = parsed.data.call;
      log(
        handled.response.kind === 'certified'
          ? `certified ${body.client}#${body.nonce} ${body.job.kind} kernelChecked=${handled.response.cert.kernelChecked}`
          : `rejected  ${body.client}#${body.nonce} ${body.job.kind} failed=${handled.failed.join(',')}`,
      );
      return send(200, { v: LINK_VERSION, response: handled.response });
    } catch (err) {
      log(`error ${(err as Error).message}`);
      if (!res.headersSent) send(500, { error: 'internal error' });
    }
  });
}

// ---------------------------------------------------------------------------
// Calling a node
// ---------------------------------------------------------------------------

export interface CallOutcome {
  call: Call;
  response: Response;
  acceptance: Acceptance;
  /** The client state after the call; persist it so the nonce is never reused. */
  client: ClientState;
}

export class CallError extends Error {
  constructor(message: string, readonly code: string, readonly hint?: string) {
    super(message);
  }
}

/**
 * Make one certified call. The nonce is consumed before the request goes out,
 * and `persistNonce` runs then: if the request fails mid-flight and the node did
 * serve it, reusing the nonce would be a replay the node is right to refuse.
 */
export async function callNode(options: {
  client: ClientState;
  node: string;
  url: string;
  job: Job;
  fuel: number;
  argv?: string[];
  persistNonce: (client: ClientState) => void;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<CallOutcome> {
  const made = mkCall(options.client, options.node, options.job, options.fuel, options.argv);
  if (!made) throw new CallError(`no call key for node "${options.node}"`, 'UNKNOWN_NODE', 'Add it with `singularity-lean client add-node`.');
  options.persistNonce(made.client);

  const doFetch = options.fetchImpl ?? fetch;
  const url = new URL('call', options.url.endsWith('/') ? options.url : `${options.url}/`).toString();
  let res: globalThis.Response;
  try {
    res = await doFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ v: LINK_VERSION, call: made.call }),
      // The node may legitimately take the whole fuel budget; allow for it plus transport.
      signal: AbortSignal.timeout(options.timeoutMs ?? options.fuel * 1000 + 30_000),
    });
  } catch (err) {
    throw new CallError(`could not reach ${url}: ${(err as Error).message}`, 'NODE_UNREACHABLE');
  }
  const text = await res.text();
  if (!res.ok) throw new CallError(`node answered HTTP ${res.status}: ${text.slice(0, 300)}`, 'NODE_ERROR');

  const parsed = ResponseEnvelopeSchema.safeParse(JSON.parse(text));
  if (!parsed.success) throw new CallError(`node answered something that is not a ${LINK_VERSION} response`, 'BAD_RESPONSE');
  const response = parsed.data.response;
  return { call: made.call, response, acceptance: accepts(made.client, made.call, response), client: made.client };
}
