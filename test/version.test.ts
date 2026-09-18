import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { VERSION } from '../src/version.js';

/**
 * Five files carry the version and only one of them can be imported.
 *
 * `src/version.ts` said it was "kept in step by hand" with the other four, and
 * a guarantee that lives in a comment is the thing this repository keeps
 * finding out the hard way. Nothing checked it, so a bump that missed one would
 * ship a plugin manifest advertising a version the tool does not report, an npm
 * package whose `--version` disagrees with its own `package.json`, or a
 * whitepaper describing a release that was never cut. All of them type-check.
 *
 * The comparison is against `VERSION` rather than against `package.json`,
 * because `VERSION` is the one the running tool actually prints — CLI
 * `--version`, the MCP handshake, and the facts the poster draws on. If they
 * are going to disagree, this is the copy that should win.
 */

const ROOT = resolve(__dirname, '..');

function json(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(ROOT, path), 'utf8')) as Record<string, unknown>;
}

describe('the version, in every place that carries it', () => {
  it('looks like a version at all', () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('matches package.json', () => {
    expect(json('package.json').version).toBe(VERSION);
  });

  it('matches the plugin manifest', () => {
    // Claude Code reads this one. A stale copy here installs a plugin that
    // reports the wrong version and never prompts for an update.
    expect(json('.claude-plugin/plugin.json').version).toBe(VERSION);
  });

  it('matches the marketplace manifest', () => {
    const marketplace = json('.claude-plugin/marketplace.json') as {
      plugins?: Array<{ name?: string; version?: string }>;
    };

    const entry = marketplace.plugins?.find((plugin) => plugin.name === 'singularity-agent');
    expect(entry, 'the marketplace no longer lists this plugin').toBeTruthy();
    expect(entry?.version).toBe(VERSION);
  });

  it('matches the whitepaper header', () => {
    const paper = readFileSync(join(ROOT, 'whitepaper.md'), 'utf8');
    expect(paper).toContain(`Version ${VERSION}`);
  });

  it('is the version the roadmap most recently called shipped', () => {
    // The roadmap opens with the shipped releases, newest first. A bump with no
    // entry is a release nobody can read the notes for.
    const roadmap = readFileSync(join(ROOT, 'roadmap.md'), 'utf8');
    const first = /^## Shipped — v(\d+\.\d+\.\d+)/m.exec(roadmap);

    expect(first, 'no shipped section in the roadmap').toBeTruthy();
    expect(first?.[1]).toBe(VERSION);
  });
});
