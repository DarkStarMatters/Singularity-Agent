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

  /**
   * Prose that names the version, in the two places that are not manifests.
   *
   * Both of these went stale the moment v0.4.0 was cut, and nothing failed:
   * the SDK's own header explained that the agent was at v0.3.0, and the
   * roadmap's argument for why it will not predict Q3 2027 rested on having
   * reached v0.3.0 in six days. Neither is a manifest, so the checks above
   * could not see them, and both are exactly the failure the top of the
   * roadmap is about — a fact living in prose, duplicated, with nothing
   * holding the copies together.
   *
   * They are checked for the *current* version by substring rather than
   * rewritten by hand, so the next bump either updates them or turns this red.
   */
  for (const [path, why] of [
    ['singularity-sdk/src/version.ts', 'the SDK explains which agent version it is not'],
    ['roadmap.md', 'the Horizons section dates itself against the latest release'],
  ] as const) {
    it(`is the version ${path} says the agent is on, because ${why}`, () => {
      expect(readFileSync(join(ROOT, path), 'utf8')).toContain(`v${VERSION}`);
    });
  }

  it('is the version the README tells an installer they are getting', () => {
    // The README states both package versions in one place, so somebody
    // reading it before installing is not guessing from npm.
    const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
    const sdk = json('singularity-sdk/package.json').version;

    expect(readme).toContain(`| \`singularity-agent\` | \`${VERSION}\` |`);
    expect(readme).toContain(`| \`singularity-sdk\` | \`${sdk}\` |`);
  });

  it('is the release the whitepaper says is current, and the SDK requires', () => {
    // The whitepaper's header tracks the release while its body stays at the
    // version it was written for, and its note says which is which. That note
    // once said the paper "describes main" four releases after it stopped.
    const paper = readFileSync(join(ROOT, 'whitepaper.md'), 'utf8');
    expect(paper).toContain(`The current release is v${VERSION}`);

    // The SDK's peer range is its claim about which agent it was built
    // against, and the README repeats it.
    const peer = (json('singularity-sdk/package.json').peerDependencies as Record<string, string>)['singularity-agent'];
    expect(peer).toBe(`>=${VERSION}`);
    expect(readFileSync(join(ROOT, 'README.md'), 'utf8')).toContain(`\`singularity-agent ${peer}\``);
  });

  it('has one shipped entry in the roadmap for every release up to this one', () => {
    // A release with no entry is a release nobody can read the notes for; an
    // entry with no release is a note about something that never shipped.
    const roadmap = readFileSync(join(ROOT, 'roadmap.md'), 'utf8');
    const shipped = [...roadmap.matchAll(/^## Shipped — v(\d+\.\d+\.\d+)/gm)].map((m) => m[1]!);

    expect(shipped[0]).toBe(VERSION);
    expect(new Set(shipped).size, 'the roadmap lists a version twice').toBe(shipped.length);
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
