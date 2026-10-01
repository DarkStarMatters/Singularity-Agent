#!/usr/bin/env node
/**
 * The MCP server: the tool catalogue over stdio.
 *
 * Errors come back as `isError` results carrying a code and a hint, as
 * Singularity's do, so the model can correct itself rather than stall.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TOOLS, ToolError } from './tools.js';
import { VERSION } from './version.js';

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

const text = (value: unknown) => JSON.stringify(value, null, 2);

async function run(fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return { content: [{ type: 'text', text: text(await fn()) }] };
  } catch (err) {
    const payload =
      err instanceof ToolError
        ? { error: err.code, message: err.message, hint: err.hint }
        : { error: (err as { code?: string }).code ?? 'UNEXPECTED', message: err instanceof Error ? err.message : String(err) };
    return { content: [{ type: 'text', text: text(payload) }], isError: true };
  }
}

export function createServer(): McpServer {
  const server = new McpServer(
    { name: 'singularity-lean-agent', version: VERSION },
    {
      instructions: [
        "The Lean link: Lean 4 proof checking for agents, linked to the lean-worker prover (github.com/meta-introspector/lean-worker).",
        '',
        "'Proved' means `kernelAccepted: true` from `lean_check` or an accepted certificate from `lean_call` — compiled with no errors and no `sorryAx` among the declaration's axioms. A theorem count or a missing `sorry` in the text is not a proof; report the axioms when a user asks whether something is proved.",
        '',
        'These tools run the Lean compiler on this machine, and compiling Lean can execute code the file contains. They never post to the relay: `lean_relay_seal` returns the envelope and the command; the user decides whether to send it.',
        '',
        'lean-worker relay envelopes sealed with the salt from its public repository can be read by anyone, and their `agent` field is unauthenticated. Say so before treating one as private or as coming from a particular agent.',
        '',
        'When a lean_ tool fails, call `lean_doctor`.',
      ].join('\n'),
    },
  );

  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      { title: tool.title, description: tool.description, inputSchema: tool.shape, annotations: { ...tool.annotations, title: tool.title } },
      async (args: Record<string, unknown>) => run(() => tool.run(args)),
    );
  }
  return server;
}

async function main(): Promise<void> {
  await createServer().connect(new StdioServerTransport());
  process.stderr.write(`singularity-lean-agent MCP server ${VERSION} ready on stdio\n`);
}

const invokedDirectly = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(entry);
  } catch {
    return false;
  }
})();

if (invokedDirectly || process.env.SINGULARITY_LEAN_MCP_AUTOSTART === '1') {
  main().catch((err) => {
    process.stderr.write(`singularity-lean-agent failed to start: ${(err as Error).message}\n`);
    process.exit(1);
  });
}
