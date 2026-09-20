/**
 * The PrivateDAO agent exchange, as a typed client.
 *
 * An MCP server at `agents.privatedao.org/mcp` that sells verification and
 * intelligence services priced in USDC, and brokers paid jobs between agents.
 * Singularity has both halves of a relationship with it: it can *buy* those
 * services, and it can *sell* the several it already does better.
 *
 * ## Every argument shape here was discovered by probing
 *
 * This is the caveat that governs the whole file, so it goes at the top rather
 * than in a footnote. The server advertises its tools with **empty input
 * schemas** — `{"type":"object","additionalProperties":false}`, no properties,
 * for all eleven of them — while plainly requiring arguments. `verify_basic`
 * called with `{}` answers "mint or record is required".
 *
 * That is not a small problem for anything automated. An MCP client's entire
 * contract is the advertised schema; a model reading this server sends `{}`,
 * gets an error, and has nothing to correct against. So the shapes below were
 * recovered by calling each tool with no arguments and reading what it
 * complained about.
 *
 * **Which means they can drift without any warning.** A normal schema change
 * shows up in `tools/list`; a change here shows up as a failed call in
 * production. Two things follow. Every response is parsed defensively rather
 * than cast, and {@link checkSchemaDrift} exists so an application can find out
 * that the server started advertising real schemas — at which point this file
 * should be rewritten against them and most of this comment deleted.
 *
 * See `docs/privatedao-schema-report.md` for the write-up sent upstream.
 *
 * ## What comes back is untrusted
 *
 * Results describe tokens and agents that strangers registered. Nothing here
 * decides anything on their behalf: the client returns evidence and names its
 * source, exactly as the rest of this project treats a value it did not compute.
 */

import { SingularityError } from '../core/errors.js';

/** Where the exchange lives. Overridable, because a URL is not a constant. */
export const PDAO_ENDPOINT = 'https://agents.privatedao.org/mcp';

/**
 * A service the exchange sells.
 *
 * Prices are USDC and several are pennies, which is the interesting part: these
 * are priced to be bought by software making a decision, not by a person
 * filling in a form.
 */
export interface PdaoService {
  id: string;
  title: string;
  price: number;
  currency: string;
  access: 'free' | 'paid' | string;
  input: string;
  output: string;
  supportedNetworks?: string[];
}

/** The eleven tools the exchange exposes, as of protocol 2025-03-26. */
export type PdaoTool =
  | 'pdao_services'
  | 'verify_basic'
  | 'create_paid_job'
  | 'submit_payment'
  | 'job_status'
  | 'get_receipt'
  | 'search_agents'
  | 'register_agent'
  | 'agent_match'
  | 'logistics_request'
  | 'network_stats';

/**
 * What each tool requires, as recovered from its own error messages.
 *
 * Kept as data rather than scattered through call sites so that the one thing
 * this file is guessing about is written down in one place. The right-hand side
 * is the server's own wording, quoted rather than paraphrased, because it is
 * evidence for a claim this module is otherwise making without a source.
 */
export const PROBED_REQUIREMENTS: Partial<Record<PdaoTool, string>> = {
  verify_basic: 'mint or record is required',
  create_paid_job: 'unknown service',
  submit_payment: 'use_http_payment_endpoint; required: job_id, signature',
  job_status: 'The provided key element does not match the schema',
  get_receipt: 'The provided key element does not match the schema',
  register_agent: 'Invalid URL',
  logistics_request: 'capability is required',
};

export interface ExchangeConfig {
  endpoint?: string;
  /** Injected so tests need no network and an application can add its own retry. */
  fetch?: typeof globalThis.fetch;
  /** Milliseconds before a call is abandoned. Default 30s. */
  timeoutMs?: number;
}

export interface Exchange {
  /** The live service catalogue, with prices. */
  services(): Promise<PdaoService[]>;
  /** Mint metadata and largest holders. Free, and the cheapest cross-check available. */
  verifyBasic(params: { mint?: string; record?: unknown }): Promise<Record<string, unknown>>;
  /** Cluster and slot, straight from their provider. */
  networkStats(): Promise<Record<string, unknown>>;
  /** Registered agents. Returns an empty list when nobody has registered. */
  searchAgents(params?: Record<string, unknown>): Promise<unknown[]>;
  /** Open a job against a service id. Unpaid until a payment is submitted. */
  createJob(service: string, input?: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** Where a job got to. */
  jobStatus(jobId: string): Promise<Record<string, unknown>>;
  /** The exchange's own receipt for a job. */
  getReceipt(jobId: string): Promise<Record<string, unknown>>;
  /** Escape hatch: call any tool by name, for shapes this client has not typed. */
  call(tool: PdaoTool | string, args?: Record<string, unknown>): Promise<unknown>;
  /** Whether the server has started advertising real schemas. */
  checkSchemaDrift(): Promise<SchemaDrift>;
}

/**
 * Whether the server's advertised schemas still say nothing.
 *
 * The signal that this file's guesswork can be retired. `documented` counts
 * tools that declare at least one property; while it is zero, every argument
 * shape in this module is inference and should be treated as such.
 */
export interface SchemaDrift {
  tools: number;
  documented: number;
  /** True while the schemas remain empty — i.e. while probing is still needed. */
  stillUndocumented: boolean;
  note: string;
}

interface JsonRpcResponse {
  result?: { content?: Array<{ type: string; text?: string }>; structuredContent?: unknown };
  error?: unknown;
}

export function createExchange(config: ExchangeConfig = {}): Exchange {
  const endpoint = config.endpoint ?? PDAO_ENDPOINT;
  const doFetch = config.fetch ?? globalThis.fetch;
  const timeoutMs = config.timeoutMs ?? 30_000;

  let nextId = 1;

  async function rpc(method: string, params: unknown): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await doFetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // The server answers plain JSON, but the streamable-HTTP transport
          // expects a client that would accept a stream. Sending only
          // application/json is how a working call starts returning 406 after
          // an upgrade nobody told us about.
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
        signal: controller.signal,
      });
    } catch (cause) {
      clearTimeout(timer);
      throw new SingularityError(
        'ENDPOINT_FAILED',
        `The PrivateDAO exchange at ${endpoint} could not be reached: ${describe(cause)}.`,
      );
    }
    clearTimeout(timer);

    if (!response.ok) {
      throw new SingularityError(
        'ENDPOINT_FAILED',
        `The PrivateDAO exchange answered ${response.status} for ${method}.`,
      );
    }

    const body = (await response.json()) as JsonRpcResponse & {
      error?: string;
      message?: string;
    };

    // Two error shapes, because the server uses both. Tool failures come back
    // as a bare {error, message} with HTTP 200 rather than as a JSON-RPC error,
    // so checking only the spec-shaped one reads a failure as a success.
    if (typeof body.error === 'string') {
      throw new SingularityError(
        'ENDPOINT_FAILED',
        `PrivateDAO refused the call: ${body.message ?? body.error}. ` +
          'Its tools advertise empty input schemas, so the arguments this client sends were ' +
          'inferred from error messages and may have drifted — see checkSchemaDrift().',
      );
    }

    if (body.error) {
      throw new SingularityError('ENDPOINT_FAILED', `PrivateDAO returned an error for ${method}.`);
    }

    return body.result;
  }

  /**
   * Unwrap a tool result.
   *
   * MCP puts the real answer in `structuredContent` and a stringified copy in
   * `content[0].text`. Preferring the structured one avoids re-parsing, and the
   * text fallback exists because not every server sends both.
   */
  async function callTool(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const result = (await rpc('tools/call', { name, arguments: args })) as JsonRpcResponse['result'];

    if (result?.structuredContent !== undefined) return result.structuredContent;

    const text = result?.content?.find((part) => part.type === 'text')?.text;
    if (text === undefined) return result;

    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  function record(value: unknown, tool: string): Record<string, unknown> {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
    throw new SingularityError(
      'ENDPOINT_FAILED',
      `PrivateDAO's ${tool} returned ${Array.isArray(value) ? 'a list' : typeof value} where an object was expected.`,
    );
  }

  return {
    async services() {
      const body = record(await callTool('pdao_services'), 'pdao_services');
      const services = body['services'];

      if (!Array.isArray(services)) {
        throw new SingularityError(
          'ENDPOINT_FAILED',
          'PrivateDAO returned a service catalogue with no services array.',
        );
      }

      return services as PdaoService[];
    },

    async verifyBasic(params) {
      if (!params.mint && params.record === undefined) {
        // The server's own requirement, enforced here so the round trip is not
        // spent learning something already known.
        throw new SingularityError(
          'BAD_INPUT',
          'verify_basic needs a mint or a record. The server says so too, but only after a round trip.',
        );
      }

      return record(await callTool('verify_basic', { ...params }), 'verify_basic');
    },

    async networkStats() {
      return record(await callTool('network_stats'), 'network_stats');
    },

    async searchAgents(params = {}) {
      const body = record(await callTool('search_agents', params), 'search_agents');
      const agents = body['agents'];
      return Array.isArray(agents) ? agents : [];
    },

    async createJob(service, input = {}) {
      if (!service) {
        throw new SingularityError('BAD_INPUT', 'A job needs a service id — see services().');
      }
      return record(await callTool('create_paid_job', { service, ...input }), 'create_paid_job');
    },

    async jobStatus(jobId) {
      return record(await callTool('job_status', { job_id: jobId }), 'job_status');
    },

    async getReceipt(jobId) {
      return record(await callTool('get_receipt', { job_id: jobId }), 'get_receipt');
    },

    call(tool, args = {}) {
      return callTool(tool, args);
    },

    async checkSchemaDrift() {
      const listed = (await rpc('tools/list', {})) as { tools?: Array<{ inputSchema?: unknown }> };
      const tools = listed.tools ?? [];

      const documented = tools.filter((tool) => {
        const schema = tool.inputSchema as { properties?: Record<string, unknown> } | undefined;
        return Boolean(schema?.properties && Object.keys(schema.properties).length > 0);
      }).length;

      return {
        tools: tools.length,
        documented,
        stillUndocumented: documented === 0,
        note:
          documented === 0
            ? 'Every tool still advertises an empty input schema, so the argument shapes this client sends remain inferred from error messages rather than read from the server.'
            : `${documented} of ${tools.length} tools now advertise properties. Rewrite this client against the real schemas and delete the guesswork.`,
      };
    },
  };
}

function describe(cause: unknown): string {
  if (cause instanceof Error) {
    return cause.name === 'AbortError' ? 'the request timed out' : cause.message;
  }
  return String(cause);
}
