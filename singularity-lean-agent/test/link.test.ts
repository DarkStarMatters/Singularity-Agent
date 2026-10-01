import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { ClientState } from '../src/client.js';
import { callNode, createNodeServer } from '../src/http.js';
import { createServer } from '../src/mcp.js';
import { NodeQueue, type NodeState, type Runtime } from '../src/node.js';
import { LINK_VERSION, sha256Hex } from '../src/wire.js';
import { VERSION } from '../src/version.js';

const CLIENT_KEY = '44'.repeat(32);
const NODE_KEY = '55'.repeat(32);

describe('lean-link/1 over HTTP, end to end', () => {
  let server: Server;
  let url: string;
  let queue: NodeQueue;
  const runtime: Runtime = { run: async () => ({ outcome: { kind: 'proved', axioms: [] }, kernelChecked: true }) };

  beforeAll(async () => {
    const state: NodeState = {
      id: 'node',
      key: NODE_KEY,
      policy: { admittedPeers: ['singularity'], allowedExes: [], allowExeCalls: false, maxFuelPerCall: 60, fuelBudget: 1000 },
      clientKeys: { singularity: CLIENT_KEY },
      seen: [],
      fuelUsed: 0,
    };
    queue = new NodeQueue(state, runtime);
    server = createNodeServer({ queue, version: VERSION });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  const client: ClientState = { id: 'singularity', callKeys: { node: CLIENT_KEY }, verifyKeys: { node: NODE_KEY }, nextNonce: 0 };
  const job = { kind: 'proveGoal' as const, module: 'M', decl: 'M.t', sourceDigest: sha256Hex('x') };

  it('a call is certified, verified, and its nonce persisted before it is sent', async () => {
    let persisted = -1;
    const out = await callNode({ client, node: 'node', url, job, fuel: 10, persistNonce: (c) => (persisted = c.nextNonce) });
    expect(persisted).toBe(1);
    expect(out.acceptance.accepted).toBe(true);
    expect(out.client.nextNonce).toBe(1);
  });

  it('replaying the same call over the wire is refused', async () => {
    const replay = await callNode({ client, node: 'node', url, job, fuel: 10, persistNonce: () => {} });
    expect(replay.response).toEqual({ kind: 'rejected', reason: 'not admitted' });
    expect(replay.acceptance.accepted).toBe(false);
  });

  it('a malformed body never reaches the gate', async () => {
    const before = queue.current();
    const res = await fetch(`${url}/call`, { method: 'POST', body: JSON.stringify({ v: LINK_VERSION, call: { body: {} } }) });
    expect(res.status).toBe(400);
    expect(queue.current()).toBe(before);
  });

  it('/health and /info answer, and /info says what the node will do', async () => {
    expect(await (await fetch(`${url}/health`)).json()).toEqual({ ok: true, v: LINK_VERSION });
    const info = (await (await fetch(`${url}/info`)).json()) as Record<string, unknown>;
    expect(info).toMatchObject({ id: 'node', jobs: ['proveGoal', 'checkProof'], maxFuelPerCall: 60 });
    expect(info.fuelRemaining).toBe(990);
  });
});

describe('MCP surface', () => {
  async function connect() {
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0' });
    await Promise.all([createServer().connect(b), client.connect(a)]);
    return client;
  }

  it('serves exactly these tools, and only those that change nothing are marked read-only', async () => {
    const { tools } = await (await connect()).listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'lean_call',
      'lean_check',
      'lean_doctor',
      'lean_relay_open',
      'lean_relay_read',
      'lean_relay_seal',
      'lean_tasks',
      'lean_verify_certificate',
      'lean_worker_build',
    ]);
    const readOnly = tools.filter((t) => t.annotations?.readOnlyHint).map((t) => t.name).sort();
    expect(readOnly).toEqual(['lean_doctor', 'lean_relay_open', 'lean_relay_read', 'lean_tasks', 'lean_verify_certificate']);
  });

  it('no tool posts to the relay', async () => {
    const { tools } = await (await connect()).listTools();
    for (const t of tools) expect(t.name).not.toMatch(/post|publish|send/);
  });

  it('errors come back as results with a code', async () => {
    const result = (await (await connect()).callTool({ name: 'lean_check', arguments: {} })) as { isError?: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({ error: 'BAD_ARGS' });
  });

  it('seals with a warning when the salt is the public one', async () => {
    const result = (await (await connect()).callTool({
      name: 'lean_relay_seal',
      arguments: { task: 'agent-a-wave-vi', salt: 'twin-proof-wave-vi-xii-2026-09-17-mike', agent: 'agent-a', text: 'hello' },
    })) as { content: Array<{ text: string }> };
    const out = JSON.parse(result.content[0]!.text);
    expect(out.room).toBe('5ac79509b89fb8b2');
    expect(out.warnings[0]).toMatch(/anyone can derive the key/);
    expect(out.post).toMatch(/^curl -X POST/);
  });
});

describe('versions', () => {
  it('agree across the package, the plugin manifest and the marketplace', () => {
    const root = join(__dirname, '..');
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    const plugin = JSON.parse(readFileSync(join(root, '.claude-plugin', 'plugin.json'), 'utf8'));
    const market = JSON.parse(readFileSync(join(root, '..', '.claude-plugin', 'marketplace.json'), 'utf8'));
    const entry = market.plugins.find((p: { name: string }) => p.name === 'singularity-lean-agent');
    expect([pkg.version, plugin.version, entry?.version]).toEqual([VERSION, VERSION, VERSION]);
  });
});
