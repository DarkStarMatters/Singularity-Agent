import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
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
