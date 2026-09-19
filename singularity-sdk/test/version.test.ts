import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SDK_VERSION } from '../src/version.js';
import { VERSION as AGENT_VERSION } from 'singularity-agent';

/**
 * Two packages, two versions, one repository.
 *
 * The agent learned this the hard way — five files carried its version, four
 * of them could not import it, and nothing checked they agreed. The lesson
 * transfers directly, and it now has a second package to get wrong.
 */

const SDK = resolve(__dirname, '..');
const ROOT = resolve(SDK, '..');

function json(base: string, path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(base, path), 'utf8')) as Record<string, unknown>;
}

describe('the SDK version', () => {
  it('looks like a version', () => {
    expect(SDK_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('matches its own package.json', () => {
    expect(json(SDK, 'package.json').version).toBe(SDK_VERSION);
  });

  it('is the version its README claims to document', () => {
    const readme = readFileSync(join(SDK, 'README.md'), 'utf8');
    expect(readme).toContain(`v${SDK_VERSION}`);
  });

  it('is deliberately not the agent version', () => {
    // Not a typo check — a claim. The agent has nine releases behind it and
    // this package has none, and sharing a number would make the SDK look nine
    // releases more settled than it is.
    expect(SDK_VERSION).not.toBe(AGENT_VERSION);
  });
});

describe('the workspace wiring', () => {
  it('is listed as a workspace of the root package', () => {
    const root = json(ROOT, 'package.json') as { workspaces?: string[]; name?: string };
    expect(root.workspaces).toContain('singularity-sdk');
    expect(root.name).toBe('singularity-agent');
  });

  it('takes the agent as a peer, not a bundled copy', () => {
    // A real constraint, not a packaging preference. `resolveConfig` writes
    // `SINGULARITY_RPC_*` and resets the agent's chain registry, which is
    // module state. Two copies of the agent in one tree would mean the SDK
    // configuring a registry that the operations it calls are not reading
    // from — endpoint overrides that silently do nothing.
    const manifest = json(SDK, 'package.json') as {
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };

    expect(manifest.peerDependencies?.['singularity-agent']).toBeTruthy();
    expect(manifest.dependencies?.['singularity-agent']).toBeUndefined();
  });

  it('asks for an agent version that exists', () => {
    const manifest = json(SDK, 'package.json') as { peerDependencies?: Record<string, string> };
    const range = manifest.peerDependencies?.['singularity-agent'] ?? '';
    const floor = /(\d+\.\d+\.\d+)/.exec(range)?.[1];

    expect(floor, `unparseable peer range: ${range}`).toBeTruthy();
    // The floor must not be ahead of what this repository actually ships, or
    // every install of the SDK is unsatisfiable on publication day.
    expect(floor).toBe(AGENT_VERSION);
  });
});

describe('what actually gets published', () => {
  const manifest = () =>
    json(SDK, 'package.json') as {
      bin?: Record<string, string>;
      files?: string[];
      exports?: Record<string, string>;
    };

  it('keeps a shebang on the bin source, since npx execs it directly', () => {
    // The agent learned this one the expensive way. A CRLF line ending turns
    // the shebang into `#!/usr/bin/env node\r`, and every Unix install of the
    // scaffolder fails looking for an interpreter called "node\r" — on a
    // machine where nothing about the source looks wrong.
    const source = readFileSync(join(SDK, 'src', 'cli.ts'), 'utf8');
    expect(source.split('\n')[0]).toBe('#!/usr/bin/env node');
  });

  it('declares its bin under dist/, which is what `files` ships', () => {
    const { bin, files } = manifest();
    expect(files).toContain('dist');
    for (const target of Object.values(bin ?? {})) expect(target).toMatch(/^\.\/dist\//);
  });

  it('ships the templates the scaffolder copies', () => {
    // `npx singularity-sdk new` reads these out of the installed package. Left
    // out of `files`, the command installs fine and then cannot scaffold
    // anything — a failure nobody sees until a stranger runs it.
    expect(manifest().files).toContain('templates');

    for (const template of ['reader', 'monitor', 'agent']) {
      expect(existsSync(join(SDK, 'templates', template, 'package.json')), template).toBe(true);
    }
  });

  it('carries each template gitignore under a name npm will not rename', () => {
    // `npm publish` renames a packaged `.gitignore` to `.npmignore`, so the
    // templates hold `_gitignore` and the CLI restores it on scaffold. A
    // `.gitignore` here works perfectly from a clone and ships a broken
    // template to everyone installing from the registry.
    for (const template of ['reader', 'monitor', 'agent']) {
      expect(existsSync(join(SDK, 'templates', template, '_gitignore')), template).toBe(true);
      expect(existsSync(join(SDK, 'templates', template, '.gitignore')), template).toBe(false);
    }
  });
});
