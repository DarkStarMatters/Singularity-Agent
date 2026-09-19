#!/usr/bin/env node
/**
 * `singularity-sdk new <name>` — a project that runs on the first try.
 *
 * The templates are deliberately small and deliberately complete. Every one of
 * them typechecks, runs against public endpoints with no key, and prints
 * something real. A scaffold that needs three edits before it does anything is
 * a scaffold nobody finds out is broken.
 *
 * What none of them contain is a key, a `.env` with a secret in it, or a signer
 * implementation. The `agent` template gets a `Signer` *stub* that throws with
 * instructions, because the alternative — a working keypair signer, commented
 * out, one line from being uncommented — is how a private key ends up in a
 * public repository. The stub is the correct shape and the wrong behaviour, and
 * that is the safer of the two ways to be incomplete.
 */

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SDK_VERSION } from './version.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/** `dist/cli.js` → package root → `templates/`. */
const TEMPLATES = resolve(HERE, '..', 'templates');

interface Template {
  id: string;
  summary: string;
}

const TEMPLATES_LIST: Template[] = [
  { id: 'reader', summary: 'A read-only script: balances, portfolio, completeness. No keys, no signer.' },
  { id: 'monitor', summary: 'A liveness and balance watcher, with backoff and clean shutdown.' },
  { id: 'agent', summary: 'A tool-use loop over the catalogue, with a policy hook and a signer stub.' },
];

function usage(): void {
  console.log(`singularity-sdk ${SDK_VERSION}

  singularity-sdk new <directory> [--template <id>]
  singularity-sdk templates

Templates:
${TEMPLATES_LIST.map((t) => `  ${t.id.padEnd(9)} ${t.summary}`).join('\n')}

Default template: reader
`);
}

function scaffold(target: string, templateId: string): void {
  const source = join(TEMPLATES, templateId);

  if (!existsSync(source)) {
    console.error(`No template named "${templateId}".`);
    console.error(`Available: ${TEMPLATES_LIST.map((t) => t.id).join(', ')}.`);
    process.exitCode = 1;
    return;
  }

  const dest = resolve(process.cwd(), target);

  // Refuse rather than merge. A scaffolder that writes into a directory
  // somebody is already working in is a scaffolder that overwrites their
  // `index.ts` exactly once, and they find out from git.
  if (existsSync(dest) && readdirSync(dest).length > 0) {
    console.error(`${dest} already exists and is not empty.`);
    console.error('Pick a new directory, or empty that one first. Nothing was written.');
    process.exitCode = 1;
    return;
  }

  mkdirSync(dest, { recursive: true });
  cpSync(source, dest, { recursive: true });

  // `npm publish` renames a packaged `.gitignore` to `.npmignore`, so the
  // templates carry `_gitignore` and it is restored here. Without this the
  // scaffold works perfectly from a clone and ships a `node_modules` to
  // everyone who installs from the registry — which is the worse half of a bug
  // that only appears after publishing.
  const ignore = join(dest, '_gitignore');
  if (existsSync(ignore)) renameSync(ignore, join(dest, '.gitignore'));

  // The template's package.json carries a placeholder name and a placeholder
  // version for this SDK, so a scaffold pins the version that generated it
  // rather than whatever `latest` becomes.
  const manifestPath = join(dest, 'package.json');
  if (existsSync(manifestPath)) {
    const manifest = readFileSync(manifestPath, 'utf8')
      .replace(/__APP_NAME__/g, basename(target))
      .replace(/__SDK_VERSION__/g, SDK_VERSION);
    writeFileSync(manifestPath, manifest);
  }

  console.log(`Created ${dest} from the "${templateId}" template.

  cd ${target}
  npm install
  npm start

It reads public endpoints and needs no key to run. Set SINGULARITY_RPC_* in
.env for endpoints of your own — the public ones are rate-limited.`);
}

/** Last path segment, for naming the package. Not `path.basename`: that keeps
 *  a trailing `.` or an absolute root, and neither is a valid package name. */
function basename(target: string): string {
  const parts = target.split(/[\\/]/).filter((p) => p && p !== '.' && p !== '..');
  const last = parts[parts.length - 1] ?? 'singularity-app';
  return last.toLowerCase().replace(/[^a-z0-9._-]/g, '-');
}

function main(argv: string[]): void {
  const [command, ...rest] = argv;

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    usage();
    return;
  }

  if (command === 'version' || command === '--version' || command === '-v') {
    console.log(SDK_VERSION);
    return;
  }

  if (command === 'templates') {
    for (const template of TEMPLATES_LIST) console.log(`${template.id.padEnd(9)} ${template.summary}`);
    return;
  }

  if (command === 'new') {
    const target = rest.find((arg) => !arg.startsWith('-'));
    if (!target) {
      console.error('Usage: singularity-sdk new <directory> [--template <id>]');
      process.exitCode = 1;
      return;
    }

    const flag = rest.indexOf('--template');
    const template = flag >= 0 ? rest[flag + 1] : undefined;
    scaffold(target, template ?? 'reader');
    return;
  }

  console.error(`Unknown command "${command}".`);
  usage();
  process.exitCode = 1;
}

main(process.argv.slice(2));
