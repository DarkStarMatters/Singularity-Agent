import { describe, it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/mcp/server.js';

/**
 * Exercises the MCP surface over a real client/server pair, so a broken tool
 * registration fails here rather than silently at runtime in a host.
 */
async function connect(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer();
  const client = new Client({ name: 'test', version: '0.0.0' });

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function textOf(result: unknown): string {
  const content = (result as { content: Array<{ text: string }> }).content;
  return content[0]?.text ?? '';
}

describe('MCP server', () => {
  it('registers the full tool surface', async () => {
    const client = await connect();
    const { tools } = await client.listTools();

    expect(tools.map((t) => t.name).sort()).toEqual([
      'balance',
      'block',
      'build_burn',
      'build_transfer',
      'chains',
      'decode',
      'fees',
      'mint_audit',
      'portfolio',
      'read_contract',
      'resolve',
      'token_identity',
      'transaction',
      'verify_burn',
    ]);
  });

  it('describes every tool and marks it read-only', async () => {
    const client = await connect();
    const { tools } = await client.listTools();

    for (const tool of tools) {
      expect(tool.description, `${tool.name} needs a description`).toBeTruthy();
      expect(tool.annotations?.readOnlyHint, `${tool.name} must be read-only`).toBe(true);
      expect(tool.inputSchema).toBeTruthy();
    }
  });

  it('answers chains without touching the network', async () => {
    const client = await connect();
    const result = await client.callTool({ name: 'chains', arguments: { family: 'cosmos' } });

    const chains = JSON.parse(textOf(result)) as Array<{ id: string; family: string }>;
    expect(chains.length).toBeGreaterThan(0);
    expect(chains.every((c) => c.family === 'cosmos')).toBe(true);
  });

  it('decodes calldata through the tool interface', async () => {
    const client = await connect();
    const result = await client.callTool({
      name: 'decode',
      arguments: {
        data:
          '0xa9059cbb000000000000000000000000d8da6bf26964af9d7eed9e03e53415d37aa96045' +
          '00000000000000000000000000000000000000000000000000000000000f4240',
      },
    });

    expect(JSON.parse(textOf(result))).toMatchObject({ name: 'transfer' });
  });

  it('returns errors as structured results the model can act on', async () => {
    const client = await connect();
    const result = await client.callTool({
      name: 'balance',
      arguments: { address: '0xnope', chain: 'not-a-real-chain' },
    });

    expect((result as { isError?: boolean }).isError).toBe(true);

    const payload = JSON.parse(textOf(result)) as { error: string; hint?: string };
    expect(payload.error).toBe('UNKNOWN_CHAIN');
    expect(payload.hint).toBeTruthy();
  });

  it('tells portfolio and balance to accept the same inputs', async () => {
    // portfolio once advertised ENS support but never resolved a name, so every
    // chain rejected it and the call failed with NO_MATCHING_CHAINS.
    const client = await connect();
    const { tools } = await client.listTools();

    for (const name of ['balance', 'portfolio']) {
      const tool = tools.find((t) => t.name === name);
      const address = (tool?.inputSchema as { properties?: Record<string, { description?: string }> })
        ?.properties?.address;
      expect(address?.description, `${name} should document name support`).toMatch(/name/i);
    }
  });

  it('rejects an invalid address with a format hint rather than a crash', async () => {
    const client = await connect();
    const result = await client.callTool({
      name: 'balance',
      arguments: { address: '0xdeadbeef', chain: 'base' },
    });

    expect((result as { isError?: boolean }).isError).toBe(true);
    const payload = JSON.parse(textOf(result)) as { error: string; hint?: string };
    expect(payload.error).toBe('INVALID_ADDRESS');
    expect(payload.hint).toMatch(/40 hex/);
  });
});
