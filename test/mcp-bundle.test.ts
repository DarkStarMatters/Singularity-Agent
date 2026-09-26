import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { TOOLS } from '../src/tools/catalog.js';

/**
 * The single-file MCP server the Claude Code plugin runs.
 *
 * It exists because the unbundled server reads 1,363 files on start, and from a
 * cold cache that crossed Claude Code's 30 s connect limit (see
 * scripts/bundle-mcp.mjs). Both of its properties are the whole point, so both
 * are held here: it reads nothing from node_modules, and it is still the same
 * server — every tool in the catalogue, served over a real stdio process.
 */

const ROOT = resolve(__dirname, '..');
const SLOW = 180_000;

interface Metafile {
  outputs: Record<string, { imports: Array<{ path: string; external?: boolean }> }>;
}

let dir: string;
let bundle: string;
let metafile: Metafile;
let optionalAddons: string[];

beforeAll(async () => {
  const script = (await import('../scripts/bundle-mcp.mjs')) as {
    bundleMcpServer: (outfile: string) => Promise<{ metafile: Metafile }>;
    OPTIONAL_ADDONS: string[];
  };
  const { bundleMcpServer } = script;
  optionalAddons = script.OPTIONAL_ADDONS;
  // Outside the repository, so the repo's node_modules is not beside it.
  dir = mkdtempSync(join(tmpdir(), 'singularity-bundle-'));
  bundle = join(dir, 'server.bundle.js');
  ({ metafile } = await bundleMcpServer(bundle));
}, SLOW);

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('the bundled MCP server', () => {
  it('leaves nothing external but Node built-ins', () => {
    // esbuild's own record of what it did not inline. Scanning the output text
    // instead finds import statements inside JSDoc examples and ajv's code
    // templates, which are strings, not imports.
    const externals = Object.values(metafile.outputs).flatMap((output) =>
      output.imports.filter((entry) => entry.external).map((entry) => entry.path),
    );

    expect(externals.length).toBeGreaterThan(0);
    const outside = externals.filter(
      (specifier) => !isBuiltin(specifier) && !optionalAddons.includes(specifier),
    );
    expect(outside, 'these would be read from node_modules at startup').toEqual([]);
  });

  it('serves every tool in the catalogue over stdio', async () => {
    const client = new Client({ name: 'bundle-test', version: '0.0.0' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [bundle],
      cwd: ROOT,
      stderr: 'ignore',
    });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual(TOOLS.map((t) => t.name).sort());

      const result = await client.callTool({ name: 'chains', arguments: {} });
      expect(result.isError).toBeFalsy();
    } finally {
      await client.close();
    }
  }, SLOW);

  it('is what the plugin manifest runs', () => {
    const plugin = JSON.parse(readFileSync(join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8')) as {
      mcpServers: Record<string, { args: string[] }>;
    };
    expect(plugin.mcpServers.singularity?.args).toEqual([
      '${CLAUDE_PLUGIN_ROOT}/dist/mcp/server.bundle.js',
    ]);
  });
});
