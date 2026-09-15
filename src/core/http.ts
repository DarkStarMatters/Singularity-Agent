import { RpcError } from './errors.js';
import type { ChainSpec } from './types.js';

const DEFAULT_TIMEOUT_MS = Number(process.env.SINGULARITY_TIMEOUT_MS ?? 15_000);

export interface FetchOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** Treat a 404 as a null result rather than an error (common for "not found"). */
  nullOn404?: boolean;
}

async function once(url: string, options: FetchOptions): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    return await fetch(url, {
      method: options.method ?? 'GET',
      headers: {
        accept: 'application/json',
        ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...options.headers,
      },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Try each endpoint in order and return the first success.
 *
 * Public RPCs fail constantly — rate limits, cold nodes, transient 5xx — so
 * failover is the normal path here, not an edge case. Only the last error is
 * surfaced, with all attempts summarized.
 */
export async function fetchWithFailover<T>(
  chain: ChainSpec,
  path: string,
  options: FetchOptions = {},
): Promise<T | null> {
  const failures: string[] = [];

  for (const endpoint of chain.rpc) {
    const url = path ? `${endpoint.replace(/\/$/, '')}${path.startsWith('/') ? path : `/${path}`}` : endpoint;
    try {
      const response = await once(url, options);

      if (response.status === 404 && options.nullOn404) return null;

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        failures.push(`${hostOf(url)} -> HTTP ${response.status}${text ? `: ${truncate(text)}` : ''}`);
        continue;
      }

      const text = await response.text();
      if (!text) return null;
      try {
        return JSON.parse(text) as T;
      } catch {
        // Esplora returns bare strings (block hashes, heights) with no JSON quoting.
        return text.trim() as unknown as T;
      }
    } catch (err) {
      const reason = (err as Error).name === 'AbortError' ? 'timed out' : (err as Error).message;
      failures.push(`${hostOf(url)} -> ${reason}`);
    }
  }

  throw new RpcError(chain.id, `all ${chain.rpc.length} endpoint(s) failed [${failures.join('; ')}]`);
}

interface JsonRpcResponse<T> {
  result?: T;
  error?: { code: number; message: string };
}

/** JSON-RPC 2.0 over the same failover logic. Used by EVM and Solana. */
export async function jsonRpc<T>(
  chain: ChainSpec,
  method: string,
  params: unknown[] = [],
  timeoutMs?: number,
): Promise<T> {
  const body = { jsonrpc: '2.0', id: 1, method, params };
  const result = await fetchWithFailover<JsonRpcResponse<T>>(chain, '', {
    method: 'POST',
    body,
    timeoutMs,
  });

  if (!result) throw new RpcError(chain.id, `${method} returned an empty response`);
  if (result.error) {
    throw new RpcError(
      chain.id,
      `${method} -> ${result.error.message} (code ${result.error.code})`,
      result.error.code === -32601
        ? `This endpoint does not expose ${method}. Point SINGULARITY_RPC_${chain.id.toUpperCase().replace(/-/g, '_')} at a fuller node.`
        : undefined,
    );
  }
  return result.result as T;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function truncate(text: string, max = 120): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length <= max ? clean : `${clean.slice(0, max)}…`;
}
