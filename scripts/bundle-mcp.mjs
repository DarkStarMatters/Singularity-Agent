#!/usr/bin/env node
/**
 * Bundle the MCP server into one file, which is what the Claude Code plugin runs.
 *
 * Unbundled, starting the server loads 1,363 module files, 1,221 of them viem
 * and its `ox` dependency (722 from `viem/chains` alone). From a warm file cache
 * that takes about 2.5 s. From a cold one — the first session after a while, two
 * copies of the server launched at once, antivirus opening every file — it took
 * 20 to 30 s, against Claude Code's 30 s connect limit, and from 2026-09-18 it
 * started losing: `CONNECT_TIMEOUT`, five sessions out of the last eight. The
 * server was never broken; it was slow to read.
 *
 * One file is one read. Measured on the same machine: 0.35 s warm, against 2.7 s.
 *
 * The npm binaries stay on the tsc output (`dist/mcp/server.js`); this is an
 * extra artefact beside it, and `test/mcp-bundle.test.ts` holds it to importing
 * nothing but Node built-ins and serving the whole catalogue.
 */
import { build } from 'esbuild';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const ENTRY = resolve(ROOT, 'src/mcp/server.ts');
export const OUTFILE = resolve(ROOT, 'dist/mcp/server.bundle.js');

/**
 * CommonJS dependencies call `require`, which an ES module does not have. The
 * banner gives the bundle one, bound to its own location.
 */
const BANNER = "import { createRequire as __singularityRequire } from 'node:module';\nconst require = __singularityRequire(import.meta.url);";

/**
 * Optional native add-ons that dependencies load inside try/catch and do without:
 * node-fetch's `encoding`, and ws's `bufferutil` and `utf-8-validate`. None is
 * installed, so the unbundled server takes the same fallback. Named here so that
 * any *other* external fails `test/mcp-bundle.test.ts` instead of being read
 * from node_modules at startup.
 */
export const OPTIONAL_ADDONS = ['encoding', 'bufferutil', 'utf-8-validate'];

export async function bundleMcpServer(outfile = OUTFILE) {
  const result = await build({
    external: OPTIONAL_ADDONS,
    entryPoints: [ENTRY],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    banner: { js: BANNER },
    legalComments: 'none',
    logLevel: 'warning',
    metafile: true,
  });
  return result;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { metafile } = await bundleMcpServer();
  const inputs = Object.keys(metafile.inputs).length;
  const bytes = metafile.outputs[Object.keys(metafile.outputs)[0]].bytes;
  process.stdout.write(`bundled ${inputs} modules into dist/mcp/server.bundle.js (${(bytes / 1e6).toFixed(1)} MB)\n`);
}
