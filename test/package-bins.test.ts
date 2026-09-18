import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The install line in the README is a claim about a stranger's machine.
 *
 * `npx <package>` does not run "the package". It looks for a bin whose name
 * matches the package name, and where there is no such bin and more than one
 * candidate it refuses with "could not determine executable to run" rather than
 * guessing. This package declared `singularity` and `singularity-mcp` and was
 * named `singularity-agent`, so the one-line install that every announcement
 * would lead with failed for everybody, while every path tested from inside the
 * repo — `npm link`, a relative `node dist/...`, the plugin's
 * `${CLAUDE_PLUGIN_ROOT}` — worked exactly as written.
 *
 * That is this repo's recurring shape: correct behaviour locally, an invisible
 * failure at the boundary where someone else is holding it. So the bin table is
 * held to the two things the README promises — that the package name is itself
 * runnable, and that every declared bin points at a file the build actually
 * emits, since `files` excludes source maps and could as easily exclude an
 * entry point.
 */

const ROOT = resolve(__dirname, '..');

interface PackageJson {
  name: string;
  bin: Record<string, string>;
  files: string[];
}

const pkg = (): PackageJson =>
  JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as PackageJson;

describe('the bin table, which npx reads before it runs anything', () => {
  it('exposes a bin named for the package, so `npx singularity-agent` resolves', () => {
    const { name, bin } = pkg();
    expect(Object.keys(bin)).toContain(name);
  });

  it('points that bin at the CLI rather than the MCP server', () => {
    const { name, bin } = pkg();
    expect(bin[name]).toBe(bin.singularity);
  });

  it('declares every bin as a path under dist/, which is what `files` ships', () => {
    const { bin, files } = pkg();
    expect(files).toContain('dist');
    for (const target of Object.values(bin)) {
      expect(target).toMatch(/^\.\/dist\//);
    }
  });

  it('keeps a shebang on every bin source, since npx execs them directly', () => {
    const { bin } = pkg();
    const sources = new Set(
      Object.values(bin).map((target) =>
        target.replace(/^\.\/dist\//, 'src/').replace(/\.js$/, '.ts'),
      ),
    );
    for (const source of sources) {
      const first = readFileSync(resolve(ROOT, source), 'utf8').split('\n')[0];
      expect(first).toBe('#!/usr/bin/env node');
    }
  });
});
