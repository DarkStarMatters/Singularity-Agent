import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * The README's tables for the surfaces that are not tools or commands.
 *
 * The tools, the CLI and the bot commands are held row for row elsewhere. What
 * was left over — npm scripts, the binaries, the SDK's own CLI, the HTTP routes
 * — was documented five scripts out of fourteen, and not at all. Same failure,
 * smaller surfaces: a thing that exists and is not written down is a thing
 * nobody finds, so each table here is compared to what it describes.
 */

const ROOT = resolve(__dirname, '..');

function read(path: string): string {
  return readFileSync(join(ROOT, path), 'utf8');
}

function json(path: string): Record<string, unknown> {
  return JSON.parse(read(path)) as Record<string, unknown>;
}

/** The first-column code spans of the table that starts after `marker`. */
function column(marker: string): string[] {
  const readme = read('README.md');
  const start = readme.indexOf(marker);
  expect(start, `the README no longer contains "${marker}"`).toBeGreaterThanOrEqual(0);

  const rest = readme.slice(start + marker.length).split('\n');
  const first = rest.findIndex((line) => line.startsWith('|'));
  const rows: string[] = [];
  for (const line of rest.slice(first)) {
    if (!line.startsWith('|')) break;
    const cell = /^\| `([^`]+)`/.exec(line);
    if (cell) rows.push(cell[1]!);
  }
  return rows;
}

describe('the README, for everything that is not a tool or a command', () => {
  it('lists every npm script, and no others', () => {
    const scripts = Object.keys(json('package.json').scripts as Record<string, string>);
    const listed = column('Every script in `package.json`:').map((row) => {
      const match = /^npm (?:run )?([\w:-]+)/.exec(row);
      return match?.[1] ?? row;
    });

    expect([...listed].sort()).toEqual([...scripts].sort());
  });

  it('lists every binary the package installs', () => {
    const bins = Object.keys(json('package.json').bin as Record<string, string>);
    expect([...column('the three binaries the package installs:')].sort()).toEqual([...bins].sort());
  });

  it('lists the SDK CLI and every template it can scaffold', () => {
    const commands = column('The package ships one binary, `singularity-sdk`, and it only scaffolds:');
    expect(commands.length).toBeGreaterThan(0);
    expect(commands.every((row) => row.startsWith('singularity-sdk '))).toBe(true);

    const cli = read('singularity-sdk/src/cli.ts');
    const inCode = [...cli.matchAll(/\{ id: '([a-z]+)'/g)].map((m) => m[1]!);
    const onDisk = readdirSync(join(ROOT, 'singularity-sdk/templates'));
    const listed = column('| Template | What it is |');

    expect([...inCode].sort()).toEqual([...onDisk].sort());
    expect([...listed].sort()).toEqual([...onDisk].sort());
  });

  it('lists every HTTP route under api/', () => {
    const routes = readdirSync(join(ROOT, 'api'))
      .filter((file) => file.endsWith('.ts'))
      .map((file) => `/api/${file.replace(/\.ts$/, '')}`);

    // A rewritten route reads `/mcp` → `/api/mcp`; the function is the last span.
    const readme = read('README.md');
    const section = readme.slice(readme.indexOf('| Route | Methods | What it is |'));
    const table = section.slice(0, section.indexOf('\n\n'));
    const listed = table
      .split('\n')
      .map((line) => line.split('|')[1] ?? '')
      .map((cell) => [...cell.matchAll(/`(\/api\/[\w-]+)`/g)].pop()?.[1])
      .filter((route): route is string => Boolean(route));

    expect([...listed].sort()).toEqual([...routes].sort());
  });
});
