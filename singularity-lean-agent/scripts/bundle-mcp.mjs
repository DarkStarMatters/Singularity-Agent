#!/usr/bin/env node
/**
 * Bundle the MCP server into one file for the plugin to run, for the same
 * reason Singularity's is bundled (scripts/bundle-mcp.mjs at the repo root):
 * Claude Code gives a server 30 s to connect, and loading a module tree file by
 * file from a cold cache, under antivirus, on OneDrive, has missed that.
 */
import { build } from 'esbuild';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

await build({
  entryPoints: [resolve(ROOT, 'src/mcp.ts')],
  outfile: resolve(ROOT, 'dist/mcp.bundle.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  banner: { js: "import { createRequire as __leanRequire } from 'node:module';\nconst require = __leanRequire(import.meta.url);" },
  legalComments: 'none',
  logLevel: 'warning',
});
process.stdout.write('bundled dist/mcp.bundle.js\n');
