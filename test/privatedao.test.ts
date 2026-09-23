import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkReceipt, createExchange, PROBED_REQUIREMENTS } from '../src/exchange/privatedao.js';

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

  const fetch = (async (url: string, init: any) => {
    const body = JSON.parse(init.body);
    calls.push({ ...body, url });

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

describe('buying a job', () => {
  const JOB = 'job_33640e3c-5bdb-42bb-a250-129840776b37';
  const SIG = '3C4s5ngiJP23vABg8h3rKWwZVnUaYNmaa3EhY3NhrdcBrMBdgqk3hkpdFEBqytGFEnZrVnQLRt6nHYb3nYXsYq6f';

  it('opens a job with the service_id and nested input the schema advertises', async () => {
    // The probed shape spread the input beside `service`; the advertised one
    // nests it and names the field `service_id`, with additionalProperties off.
    const { fetch, calls } = fakeFetch(() => toolResult({ status: 'awaiting_payment' }));

    await createExchange({ fetch }).createJob('token.intelligence', { asset: 'EPjF' });

    expect(calls[0].params.arguments).toEqual({
      service_id: 'token.intelligence',
      input: { asset: 'EPjF' },
    });
  });

  it('submits the payment over HTTP, on the endpoint host, not through the MCP tool', async () => {
    // The MCP tool answers use_http_payment_endpoint and credits nothing. This
    // response is the recorded shape of a real 0.03 USDC job being credited.
    const { fetch, calls } = fakeFetch(() => ({
      job_id: JOB,
      status: 'completed',
      receipt: { receipt_id: 'rvr_fe53c65da876a1798a5b6ae36af3f27e', status: 'VERIFIED' },
    }));

    const job = await createExchange({ fetch }).submitPayment(JOB, SIG);

    expect(calls[0].url).toBe(`https://agents.privatedao.org/api/jobs/${JOB}/payment`);
    expect(calls[0].signature).toBe(SIG);
    expect(calls[0].method).toBeUndefined();
    expect(job['status']).toBe('completed');
  });

  it('says a refused payment is still provable, in the words the server used', async () => {
    const { fetch } = fakeFetch(() => ({ error: 'request_failed', message: 'job not found' }), 404);

    await expect(createExchange({ fetch }).submitPayment(JOB, SIG)).rejects.toThrow(
      /job not found.*keep the signature/,
    );
  });

  it('refuses to post a signature for something that is not a job id', async () => {
    // The id goes into a URL path, so a crafted one is a different request.
    const { fetch, calls } = fakeFetch(() => ({}));

    await expect(createExchange({ fetch }).submitPayment('../admin', SIG)).rejects.toThrow(/job_/);
    expect(calls).toHaveLength(0);
  });

  it('fetches a receipt by its receipt id', async () => {
    const { fetch, calls } = fakeFetch(() => toolResult({ status: 'VERIFIED' }));

    await createExchange({ fetch }).getReceipt('rvr_fe53c65da876a1798a5b6ae36af3f27e');

    expect(calls[0].params.arguments).toEqual({ receipt_id: 'rvr_fe53c65da876a1798a5b6ae36af3f27e' });
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

describe('re-deriving a receipt instead of trusting it', () => {
  // The first job the exchange credited, recorded whole: 0.03 USDC for
  // token.intelligence on the USDC mint, 2026-09-23.
  const job = JSON.parse(
    readFileSync(join(__dirname, 'fixtures', 'privatedao-job-2026-09-23.json'), 'utf8'),
  ) as Record<string, unknown>;
  const input = { network: 'solana-mainnet-beta', asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' };

  it('reproduces both hashes of a real receipt', () => {
    const check = checkReceipt(job, input);

    expect(check.inputHash.derived).toBe('fd2e6b72a91675d741a289236bfe3dfdec286e640fc597ee6ea1b5652d7f41f0');
    expect(check.resultHash.derived).toBe('7c77e159ea2ec8bdc6b045708765c330bbafe807db6b935ae26eaec8f7e4630f');
    expect(check.holds).toBe(true);
    expect(check.paymentSignature).toMatch(/^3C4s5ngi/);
  });

  it('does not care what order the keys were sent in', () => {
    const reordered = { asset: input.asset, network: input.network };
    expect(checkReceipt(job, reordered).inputHash.holds).toBe(true);
  });

  it('notices a result that is not the one the receipt covers', () => {
    const tampered = { ...job, result: { ...(job['result'] as object), supply: '1' } };

    const check = checkReceipt(tampered, input);

    expect(check.resultHash.holds).toBe(false);
    expect(check.holds).toBe(false);
    expect(check.note).toMatch(/result hash differ/);
  });

  it('notices an input other than the one sent', () => {
    const check = checkReceipt(job, { ...input, asset: 'So11111111111111111111111111111111111111112' });
    expect(check.inputHash.holds).toBe(false);
  });

  it('says so when there is nothing to check', () => {
    const check = checkReceipt({ result: {} }, input);
    expect(check.holds).toBe(false);
    expect(check.note).toMatch(/no receipt hashes/);
  });
});
