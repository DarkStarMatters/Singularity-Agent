#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TOOLS } from '../tools/catalog.js';
import { SingularityError } from '../core/errors.js';
import { toJson } from '../core/format.js';
import { VERSION } from '../version.js';

/**
 * Every tool returns text content holding pretty JSON.
 *
 * Errors come back as `isError` results with a code and a hint rather than
 * thrown exceptions, so the model can correct itself instead of stalling on a
 * transport error it cannot see into.
 */
type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

function ok(value: unknown): ToolResult {
  return { content: [{ type: 'text', text: toJson(value) }] };
}

function fail(err: unknown): ToolResult {
  const payload =
    err instanceof SingularityError
      ? { error: err.code, message: err.message, hint: err.hint }
      : { error: 'UNEXPECTED', message: err instanceof Error ? err.message : String(err) };

  return { content: [{ type: 'text', text: toJson(payload) }], isError: true };
}

async function run(fn: () => Promise<unknown> | unknown): Promise<ToolResult> {
  try {
    return ok(await fn());
  } catch (err) {
    return fail(err);
  }
}

export function createServer(): McpServer {
  const server = new McpServer(
    { name: 'singularity-agent', version: VERSION },
    {
      instructions: [
        'Singularity is a read-only, multi-chain blockchain client covering EVM, Solana, Bitcoin/UTXO and Cosmos.',
        '',
        'It holds no private keys and cannot sign or broadcast. `build_transfer` returns an UNSIGNED payload for the user to sign in their own wallet — always show the summary and warnings to the user before they sign.',
        '',
        'Start with `resolve` when you are handed a bare string: it identifies whether it is an address, a transaction hash, or a name, and which chains it could belong to. `chains` lists everything supported.',
        '',
        'Balances are returned without fiat pricing. On EVM chains, token lists cover a curated set of major tokens — never present them as a complete holdings list.',
      ].join('\n'),
    },
  );

  // Registered from the shared catalogue, so MCP hosts and Grok's function
  // calling see the same tool names, descriptions and argument schemas.
  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.shape,
        annotations: { ...tool.annotations, title: tool.title },
      },
      async (args: Record<string, unknown>) => run(() => tool.run(args)),
    );
  }

  return server;
}

async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout is the MCP transport — anything written there corrupts the protocol.
  process.stderr.write(`singularity-agent MCP server ${VERSION} ready on stdio\n`);
}

// Only auto-start when executed directly, so tests can import createServer().
// Comparing real paths rather than URLs keeps this correct on Windows, where
// drive letters and symlinks make naive file:// comparison unreliable.
const invokedDirectly = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(entry);
  } catch {
    return false;
  }
})();

if (invokedDirectly || process.env.SINGULARITY_MCP_AUTOSTART === '1') {
  main().catch((err) => {
    process.stderr.write(`singularity-agent failed to start: ${(err as Error).message}\n`);
    process.exit(1);
  });
}
