import { describe, it, expect } from 'vitest';
import { readdirSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import ts from 'typescript';

/**
 * The config that checks `api/` is not the config that builds it.
 *
 * `api/burn.ts` is deployed rather than published, so it was given its own
 * `tsconfig.api.json` instead of a widened `include` in the main one — which is
 * the right instinct and is exactly how it broke. Vercel's Node builder reads
 * the *root* `tsconfig.json` to compile a function, and the root config
 * declared `"rootDir": "src"`. A file outside rootDir is not a warning, it is
 * TS6059 and no output, so the deployment served a route whose module did not
 * exist: `/api/burn` answered 500 to every method, including OPTIONS, which
 * parses nothing and is the first line of the handler.
 *
 * It was invisible from here for a whole release. `npm run typecheck` was green
 * because it asks `tsconfig.api.json`, whose rootDir is "."; the local server in
 * `local/` was green because tsx ignores rootDir entirely; and every bundling
 * path — esbuild, ncc — ignores it too. The one compiler that enforces it is the
 * one nobody ran, on the machine nobody watches.
 *
 * So both halves are held here. The function must compile under the config
 * Vercel actually reads, and the build must still put `dist/` where
 * `package.json` says its binaries are — because the fix was to let rootDir be
 * inferred, and inference is only correct while `include` stays what it is.
 */

const ROOT = resolve(__dirname, '..');

/**
 * Building a ts.Program over the whole source tree takes seconds on its own and
 * longer when the rest of the suite is running beside it. The default 5s passes
 * in isolation and fails under load, which is the worst of both. A minute was
 * not enough either: under the full suite on Windows it measured seventy seconds.
 */
const SLOW = 180_000;

/** Compare emit paths without caring which separator the platform uses. */
const slashes = (path: string): string => path.split(sep).join('/');

/** Building the program twice doubles the slowest test in the suite. */
let cached: ts.Program | undefined;

function rootProgram(parsed: ts.ParsedCommandLine): ts.Program {
  cached ??= ts.createProgram(parsed.fileNames, parsed.options);
  return cached;
}

function rootConfig(): ts.ParsedCommandLine {
  const found = ts.findConfigFile(ROOT, ts.sys.fileExists, 'tsconfig.json');
  expect(found).toBeTruthy();

  const read = ts.readConfigFile(found as string, ts.sys.readFile);
  expect(read.error).toBeUndefined();

  return ts.parseJsonConfigFileContent(read.config, ts.sys, ROOT);
}

/** Every deployed function, as Vercel finds them: `.ts` files directly in api/. */
function apiEntrypoints(): string[] {
  return readdirSync(join(ROOT, 'api'))
    .filter((name) => name.endsWith('.ts'))
    .map((name) => join(ROOT, 'api', name));
}

describe('the root tsconfig, which is the one Vercel compiles functions with', () => {
  it('has at least one function to be wrong about', () => {
    expect(apiEntrypoints().length).toBeGreaterThan(0);
  });

  it('compiles every api/ entrypoint without error', () => {
    const { options } = rootConfig();
    const program = ts.createProgram(apiEntrypoints(), options);

    const errors = ts
      .getPreEmitDiagnostics(program)
      .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)
      .map(
        (diagnostic) =>
          `TS${diagnostic.code}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`,
      );

    expect(errors).toEqual([]);
  }, SLOW);

  it('does not pin a rootDir that the api/ directory falls outside of', () => {
    const { options } = rootConfig();
    if (!options.rootDir) return;

    // The specific shape that broke: rootDir "src" with a function in api/.
    // Leaving it unset infers it from `include`, which is src-only.
    for (const entry of apiEntrypoints()) {
      expect(
        entry.startsWith(resolve(options.rootDir)),
        `rootDir ${options.rootDir} excludes ${entry}, which Vercel will fail to compile`,
      ).toBe(true);
    }
  });
});

describe('the build, which inference must not have moved', () => {
  it('still roots the emit at src/', () => {
    const parsed = rootConfig();
    const program = rootProgram(parsed);

    // With rootDir unset this is what decides the shape of dist/. It is src/
    // only while `include` stays src-only; widen that and every emitted path
    // gains a directory, which is how `dist/cli/index.js` quietly becomes
    // `dist/src/cli/index.js` and every `bin` entry stops resolving.
    expect(slashes(program.getCommonSourceDirectory())).toBe(`${slashes(join(ROOT, 'src'))}/`);
    expect(parsed.options.outDir && slashes(parsed.options.outDir)).toBe(
      slashes(join(ROOT, 'dist')),
    );
  }, SLOW);

  it('emits the binaries package.json promises', () => {
    const parsed = rootConfig();
    const from = rootProgram(parsed).getCommonSourceDirectory();

    // Read off package.json rather than restated here, so a renamed binary
    // fails in this file rather than after publishing.
    const pkg = JSON.parse(ts.sys.readFile(join(ROOT, 'package.json')) ?? '{}') as {
      bin?: Record<string, string>;
    };
    const binaries = Object.values(pkg.bin ?? {});
    expect(binaries.length).toBeGreaterThan(0);

    for (const declared of binaries) {
      const relative = declared.replace('./', '');

      // "dist/cli/index.js" -> the source that has to emit to it.
      const source = join(ROOT, relative.replace('dist/', 'src/')).replace('.js', '.ts');
      expect(parsed.fileNames.map(slashes), `${declared} has no source`).toContain(slashes(source));

      const emitted = join(
        parsed.options.outDir as string,
        slashes(source).replace(slashes(from), '').replace('.ts', '.js'),
      );
      expect(slashes(emitted), `${source} must still emit to ${declared}`).toBe(
        slashes(resolve(ROOT, relative)),
      );
    }
  }, SLOW);
});
