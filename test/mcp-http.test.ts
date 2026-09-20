import { describe, it, expect } from 'vitest';
import handler from '../api/mcp.js';
import { TOOLS } from '../src/tools/catalog.js';
import { VERSION } from '../src/version.js';

/**
 * The same tools, reachable by URL instead of by spawning a process.
 *
 * The stdio server can only be used by a host willing to run a local binary.
 * Everything that connects to an endpoint — including the agent exchange this
 * was built for — was locked out. The risk in fixing that is a second tool
 * surface that drifts from the first, so the test that matters most here is
 * the one asserting both are the same catalogue.
 */

interface Captured {
  code: number;
  body: unknown;
  headers: Record<string, string>;
  ended: boolean;
}

function fakeRes(): { res: any; captured: Captured } {
  const captured: Captured = { code: 0, body: undefined, headers: {}, ended: false };

  const res = {
    status(code: number) {
      captured.code = code;
      return res;
    },
    setHeader(name: string, value: string) {
      captured.headers[name.toLowerCase()] = value;
    },
    json(body: unknown) {
      captured.body = body;
    },
    end() {
      captured.ended = true;
    },
  };

  return { res, captured };
}

async function rpc(
  body: unknown,
  method = 'POST',
  headers: Record<string, string> = {},
): Promise<Captured> {
  const { res, captured } = fakeRes();
  await handler({ method, body, headers } as any, res);
  return captured;
}

describe('the handshake', () => {
  it('identifies itself with the version the rest of the tool reports', async () => {
    const { body } = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    const result = (body as any).result;

    expect(result.serverInfo).toEqual({ name: 'singularity-agent', version: VERSION });
    expect(result.capabilities.tools).toBeDefined();
  });

  it('carries the instructions that tell a model what this will not do', async () => {
    // The sentence about holding no keys is the one worth checking survives,
    // because a host shows it to a model before any tool is called.
    const { body } = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    expect((body as any).result.instructions).toMatch(/holds no private keys/i);
  });

  it('answers a ping', async () => {
    const { body } = await rpc({ jsonrpc: '2.0', id: 2, method: 'ping' });
    expect((body as any).result).toEqual({});
  });
});

describe('the tool list, which is the whole reason this exists', () => {
  it('serves every tool the stdio server does', async () => {
    // One catalogue, two transports. Two hand-maintained lists drift, and the
    // one that drifts silently is the one nobody runs locally.
    const { body } = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
    const names = (body as any).result.tools.map((t: { name: string }) => t.name);

    expect(names).toEqual(TOOLS.map((t) => t.name));
  });

  it('advertises real parameter schemas for every tool', async () => {
    // The failure this endpoint exists partly to not repeat. The exchange it
    // talks to advertises eleven tools with empty schemas while requiring
    // arguments, which leaves a caller guessing and reading error messages.
    const { body } = await rpc({ jsonrpc: '2.0', id: 4, method: 'tools/list' });

    for (const tool of (body as any).result.tools) {
      expect(tool.inputSchema.type, tool.name).toBe('object');
      expect(Object.keys(tool.inputSchema.properties ?? {}).length, tool.name).toBeGreaterThan(0);
    }
  });

  it('marks the tools read-only, because they are', async () => {
    const { body } = await rpc({ jsonrpc: '2.0', id: 5, method: 'tools/list' });
    const balance = (body as any).result.tools.find((t: any) => t.name === 'balance');

    expect(balance.annotations.readOnlyHint).toBe(true);
  });
});

describe('calling a tool', () => {
  it('runs one and returns JSON text content', async () => {
    const { body } = await rpc({
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: { name: 'chains', arguments: { family: 'svm' } },
    });

    const result = (body as any).result;
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toBeTruthy();
  });

  it('refuses an unknown tool by name rather than returning nothing', async () => {
    // A model can name a tool it was never offered, and an empty result there
    // reads as "nothing found" instead of "that does not exist".
    const { body } = await rpc({
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'definitely_not_a_tool', arguments: {} },
    });

    const result = (body as any).result;
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).error).toBe('TOOL_NOT_AVAILABLE');
  });

  it('returns a failure as a result, not as a transport error', async () => {
    // So the caller can correct itself instead of stalling on something it
    // cannot see into.
    const { body } = await rpc({
      jsonrpc: '2.0',
      id: 8,
      method: 'tools/call',
      params: { name: 'balance', arguments: {} },
    });

    const result = (body as any).result;
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).message).toBeTruthy();
  });
});

describe('protocol manners', () => {
  it('answers a notification with 202 and no body', async () => {
    // A notification asked no question. Returning a result makes a client wait
    // for a reply to something it did not send an id for.
    const captured = await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });

    expect(captured.code).toBe(202);
    expect(captured.body).toBeUndefined();
    expect(captured.ended).toBe(true);
  });

  it('handles a batch and drops the notifications from the reply', async () => {
    const { body } = await rpc([
      { jsonrpc: '2.0', id: 9, method: 'ping' },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 10, method: 'tools/list' },
    ]);

    expect(Array.isArray(body)).toBe(true);
    expect((body as unknown[]).length).toBe(2);
  });

  it('says what it does not support rather than timing out', async () => {
    const { body } = await rpc({ jsonrpc: '2.0', id: 11, method: 'resources/list' });
    expect((body as any).error.code).toBe(-32601);
  });

  it('answers a plain GET with 200, because a crawler reads 405 as broken', async () => {
    // Health checkers, registry crawlers and people pasting the URL into a
    // browser all arrive this way, and all three treat a non-2xx as a dead
    // endpoint — which is how a working server gets reported as failing.
    const captured = await rpc(undefined, 'GET');

    expect(captured.code).toBe(200);
    expect((captured.body as any).name).toBe('singularity-agent');
    expect((captured.body as any).tools).toBeGreaterThan(0);
  });

  it('answers HEAD the same way', async () => {
    expect((await rpc(undefined, 'HEAD')).code).toBe(200);
  });

  it('still declines a GET that asks for an SSE stream', async () => {
    // The one case where 405 is correct: the spec lets a server refuse
    // server-initiated SSE, and saying so is how a client stops asking.
    const captured = await rpc(undefined, 'GET', { accept: 'text/event-stream' });

    expect(captured.code).toBe(405);
    expect((captured.body as any).error.message).toMatch(/SSE/i);
  });

  it('rejects other verbs with a usable message', async () => {
    const captured = await rpc(undefined, 'DELETE');
    expect(captured.code).toBe(405);
    expect((captured.body as any).error.message).toMatch(/JSON-RPC over POST/i);
  });

  it('answers the CORS preflight, so a browser client can reach it', async () => {
    const captured = await rpc(undefined, 'OPTIONS');
    expect(captured.code).toBe(204);
    expect(captured.headers['access-control-allow-origin']).toBe('*');
  });

  it('never lets a tool answer be cached', async () => {
    // Every tool reads live chain state. A cached balance is the failure this
    // project spends most of its effort avoiding.
    const captured = await rpc({ jsonrpc: '2.0', id: 12, method: 'ping' });
    expect(captured.headers['cache-control']).toBe('no-store');
  });

  it('reports a body that was not JSON', async () => {
    const captured = await rpc('{not json');
    expect(captured.code).toBe(400);
    expect((captured.body as any).error.code).toBe(-32700);
  });

  it('parses a stringified body, which is how some runtimes deliver it', async () => {
    const captured = await rpc(JSON.stringify({ jsonrpc: '2.0', id: 13, method: 'ping' }));
    expect((captured.body as any).result).toEqual({});
  });
});
