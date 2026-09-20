import { describe, it, expect } from 'vitest';
import { createExchange, PROBED_REQUIREMENTS } from '../src/exchange/privatedao.js';

/**
 * A client for a server that does not describe itself.
 *
 * The argument shapes this module sends were recovered from the exchange's own
 * error messages, because all eleven of its tools advertise empty input
 * schemas while plainly requiring arguments. That makes the usual guarantee —
 * "the schema says so" — unavailable, so the tests carry more weight than they
 * normally would: they pin what this client sends and how it behaves when the
 * server answers in a shape it did not expect.
 *
 * Nothing here touches the network. Every response below is a recorded shape
 * from a real call, replayed through an injected fetch.
 */

function fakeFetch(handler: (body: any) => unknown, status = 200) {
  const calls: any[] = [];

  const fetch = (async (_url: string, init: any) => {
    const body = JSON.parse(init.body);
    calls.push(body);

    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => handler(body),
    };
  }) as unknown as typeof globalThis.fetch;

  return { fetch, calls };
}

/** An MCP tool result, in the shape the exchange actually returns. */
function toolResult(value: unknown) {
  return {
    jsonrpc: '2.0',
    id: 1,
    result: {
      content: [{ type: 'text', text: JSON.stringify(value) }],
      structuredContent: value,
    },
  };
}

describe('reading the exchange', () => {
  it('returns the service catalogue with prices', async () => {
    const { fetch } = fakeFetch(() =>
      toolResult({
        services: [
          { id: 'risk.score', title: 'Risk score', price: 0.02, currency: 'USDC', access: 'paid' },
        ],
      }),
    );

    const services = await createExchange({ fetch }).services();

    expect(services[0]?.id).toBe('risk.score');
    expect(services[0]?.price).toBe(0.02);
  });

  it('returns an empty agent list rather than throwing when nobody is registered', async () => {
    // The registry really was empty when this was written. An empty list is an
    // answer, and turning it into an error would be inventing a problem.
    const { fetch } = fakeFetch(() => toolResult({ agents: [] }));
    expect(await createExchange({ fetch }).searchAgents()).toEqual([]);
  });

  it('sends the tool name and arguments MCP expects', async () => {
    const { fetch, calls } = fakeFetch(() => toolResult({ ok: true }));

    await createExchange({ fetch }).verifyBasic({ mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' });

    expect(calls[0].method).toBe('tools/call');
    expect(calls[0].params.name).toBe('verify_basic');
    expect(calls[0].params.arguments.mint).toBe('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
  });

  it('prefers structuredContent but can read the text copy', async () => {
    // Not every MCP server sends both, and re-parsing the text when the
    // structured form is present is how a client starts disagreeing with itself.
    const { fetch } = fakeFetch(() => ({
      jsonrpc: '2.0',
      id: 1,
      result: { content: [{ type: 'text', text: JSON.stringify({ services: [{ id: 'only.text' }] }) }] },
    }));

    const services = await createExchange({ fetch }).services();
    expect(services[0]?.id).toBe('only.text');
  });
});

describe('failing usefully', () => {
  it('catches the bare error shape the server returns with HTTP 200', async () => {
    // The trap worth guarding: tool failures come back as {error, message} with
    // a 200 status rather than as a JSON-RPC error, so a client checking only
    // the spec-shaped field reads a failure as a success.
    const { fetch } = fakeFetch(() => ({ error: 'request_failed', message: 'mint or record is required' }));

    await expect(createExchange({ fetch }).verifyBasic({ mint: 'x' })).rejects.toThrow(
      /mint or record is required/,
    );
  });

  it('says why a refusal might be the schema problem rather than the caller', async () => {
    const { fetch } = fakeFetch(() => ({ error: 'request_failed', message: 'unknown service' }));

    await expect(createExchange({ fetch }).createJob('nope')).rejects.toThrow(/empty input schemas/i);
  });

  it('refuses a verify with neither argument before spending a round trip', async () => {
    const { fetch, calls } = fakeFetch(() => toolResult({}));

    await expect(createExchange({ fetch }).verifyBasic({})).rejects.toThrow(/mint or a record/i);
    expect(calls).toHaveLength(0);
  });

  it('refuses a job with no service id', async () => {
    const { fetch } = fakeFetch(() => toolResult({}));
    await expect(createExchange({ fetch }).createJob('')).rejects.toThrow(/service id/i);
  });

  it('reports an HTTP failure as an endpoint failure', async () => {
    const { fetch } = fakeFetch(() => ({}), 503);
    await expect(createExchange({ fetch }).services()).rejects.toThrow(/answered 503/);
  });

  it('reports an unreachable endpoint rather than leaking the raw cause', async () => {
    const fetch = (async () => {
      throw new Error('getaddrinfo ENOTFOUND');
    }) as unknown as typeof globalThis.fetch;

    await expect(createExchange({ fetch }).services()).rejects.toThrow(/could not be reached/);
  });

  it('notices when a list arrives where an object belongs', async () => {
    // Defensive because the shapes are inferred. A cast here would turn a
    // protocol change into an undefined-property crash somewhere further away.
    const { fetch } = fakeFetch(() => toolResult([1, 2, 3]));
    await expect(createExchange({ fetch }).networkStats()).rejects.toThrow(/returned a list/);
  });

  it('notices a catalogue with no services array', async () => {
    const { fetch } = fakeFetch(() => toolResult({ nope: true }));
    await expect(createExchange({ fetch }).services()).rejects.toThrow(/no services array/);
  });
});

describe('watching for the schemas to appear', () => {
  it('reports that the tools are still undocumented', async () => {
    const { fetch } = fakeFetch(() => ({
      jsonrpc: '2.0',
      id: 1,
      result: {
        tools: [
          { name: 'verify_basic', inputSchema: { type: 'object', additionalProperties: false } },
          { name: 'register_agent', inputSchema: { type: 'object', additionalProperties: false } },
        ],
      },
    }));

    const drift = await createExchange({ fetch }).checkSchemaDrift();

    expect(drift.tools).toBe(2);
    expect(drift.documented).toBe(0);
    expect(drift.stillUndocumented).toBe(true);
    expect(drift.note).toMatch(/inferred from error messages/i);
  });

  it('tells us to rewrite the client once real schemas show up', async () => {
    // The signal that this module's guesswork can be retired, which is the
    // point of having the check at all.
    const { fetch } = fakeFetch(() => ({
      jsonrpc: '2.0',
      id: 1,
      result: {
        tools: [
          { name: 'verify_basic', inputSchema: { type: 'object', properties: { mint: { type: 'string' } } } },
          { name: 'register_agent', inputSchema: { type: 'object', additionalProperties: false } },
        ],
      },
    }));

    const drift = await createExchange({ fetch }).checkSchemaDrift();

    expect(drift.documented).toBe(1);
    expect(drift.stillUndocumented).toBe(false);
    expect(drift.note).toMatch(/rewrite this client/i);
  });

  it('keeps the probed requirements as quoted evidence', () => {
    // The one thing this file is guessing about, written down in one place and
    // in the server's own words rather than paraphrased.
    expect(PROBED_REQUIREMENTS.verify_basic).toBe('mint or record is required');
    expect(PROBED_REQUIREMENTS.register_agent).toBe('Invalid URL');
  });
});
