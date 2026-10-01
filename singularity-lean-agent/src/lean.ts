/**
 * Running Lean, and reading what it says.
 *
 * Everything goes through `lean --json`, which reports each message as one JSON
 * line with a severity and a position, so nothing here scrapes human-formatted
 * output. The one exception is the text of an `#print axioms` message, which
 * Lean only produces as prose; `parseAxioms` reads both of its shapes.
 *
 * Nothing in this file decides what counts as proved. It reports what the
 * compiler did: exit code, errors, warnings, `sorry` uses, and the axioms each
 * requested declaration rests on. `kernelAccepted` is the conjunction a caller
 * would otherwise have to remember to write: it compiled, nothing errored, and
 * no requested declaration depends on `sorryAx`.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

export interface Diagnostic {
  severity: 'error' | 'warning' | 'information';
  line: number;
  column: number;
  message: string;
}

export interface ProcessResult {
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  /** Milliseconds from spawn to exit. */
  elapsedMs: number;
}

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  /** Output beyond this is dropped, and the result says so. */
  maxOutputBytes?: number;
}

const DEFAULT_MAX_OUTPUT = 4 * 1024 * 1024;

/** Run a program without a shell. A missing program is an exit code of null with ENOENT in stderr. */
export function runProcess(command: string, args: string[], options: RunOptions): Promise<ProcessResult> {
  const started = Date.now();
  const limit = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode, timedOut, stdout, stderr, elapsedMs: Date.now() - started });
    };

    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: false,
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, options.timeoutMs);

    const take = (current: string, chunk: Buffer, label: string) => {
      if (current.length >= limit) return current;
      const next = current + chunk.toString('utf8');
      return next.length > limit ? next.slice(0, limit) + `\n[${label} truncated at ${limit} bytes]` : next;
    };
    child.stdout.on('data', (chunk: Buffer) => (stdout = take(stdout, chunk, 'stdout')));
    child.stderr.on('data', (chunk: Buffer) => (stderr = take(stderr, chunk, 'stderr')));
    child.on('error', (err) => {
      stderr += `${(err as NodeJS.ErrnoException).code ?? 'ERROR'}: ${err.message}`;
      finish(null);
    });
    child.on('close', (code) => finish(code));
  });
}

// ---------------------------------------------------------------------------
// Toolchain
// ---------------------------------------------------------------------------

export interface ToolchainReport {
  lean: string | null;
  lake: string | null;
  elan: string | null;
  /** What to do when something is missing. */
  hint?: string;
}

async function versionOf(command: string, cwd?: string): Promise<string | null> {
  const result = await runProcess(command, ['--version'], { timeoutMs: 120_000, ...(cwd ? { cwd } : {}) });
  if (result.exitCode !== 0) return null;
  return result.stdout.trim().split('\n').filter((line) => !line.startsWith('info:')).join(' ').trim() || null;
}

/**
 * Versions as seen from `cwd`, because elan picks the toolchain from the
 * nearest `lean-toolchain` file — the version that matters is the one a build
 * in that directory would use. The first call in a directory pinned to a
 * toolchain elan has not installed yet downloads it, hence the long timeout.
 */
export async function toolchain(cwd?: string): Promise<ToolchainReport> {
  const [lean, lake, elan] = await Promise.all([versionOf('lean', cwd), versionOf('lake', cwd), versionOf('elan', cwd)]);
  const report: ToolchainReport = { lean, lake, elan };
  if (!lean) {
    report.hint = elan
      ? 'elan is installed but `lean` did not run. Run `elan default stable` or open a directory with a lean-toolchain file.'
      : 'Lean is not installed. Install elan: https://leanprover-community.github.io/get_started.html — it manages Lean versions per project.';
  }
  return report;
}

// ---------------------------------------------------------------------------
// Parsing compiler output
// ---------------------------------------------------------------------------

/** Read `lean --json` output: one message per line. Non-JSON lines are kept as errors so nothing is lost. */
export function parseJsonMessages(stdout: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    try {
      const msg = JSON.parse(line) as {
        severity?: string;
        pos?: { line?: number; column?: number };
        data?: string;
        caption?: string;
      };
      const severity = msg.severity === 'error' || msg.severity === 'warning' ? msg.severity : 'information';
      out.push({ severity, line: msg.pos?.line ?? 0, column: msg.pos?.column ?? 0, message: String(msg.data ?? '') });
    } catch {
      out.push({ severity: 'error', line: 0, column: 0, message: line });
    }
  }
  return out;
}

export function isSorryWarning(d: Diagnostic): boolean {
  return d.severity === 'warning' && /declaration uses .sorry./.test(d.message);
}

/**
 * The axioms an `#print axioms` message names.
 *
 *   'foo' does not depend on any axioms
 *   'bar' depends on axioms: [propext, sorryAx]
 *
 * Returns null for any other message.
 */
export function parseAxioms(message: string): { decl: string; axioms: string[] } | null {
  const none = /^'(.+)' does not depend on any axioms\s*$/s.exec(message);
  if (none) return { decl: none[1]!, axioms: [] };
  const some = /^'(.+)' depends on axioms: \[([^\]]*)\]\s*$/s.exec(message);
  if (some) {
    const axioms = some[2]!.split(',').map((a) => a.trim()).filter(Boolean);
    return { decl: some[1]!, axioms };
  }
  return null;
}

const DECL = /^[ \t]*(?:@\[[^\]]*\][ \t]*)?(?:(?:private|protected|noncomputable)[ \t]+)*(theorem|lemma)[ \t]+([^\s:({[]+)/gm;

/** Theorem names declared in a source file, by a syntactic scan. Lean's own count is the sorry and error diagnostics. */
export function declaredTheorems(source: string): string[] {
  return [...source.matchAll(DECL)].map((m) => m[2]!);
}

/** Textual `sorry` occurrences outside comments — what upstream's grep counted, kept for comparison. */
export function textualSorries(source: string): number {
  const stripped = source.replace(/\/-[\s\S]*?-\//g, '').replace(/--.*$/gm, '');
  return (stripped.match(/\bsorry\b/g) ?? []).length;
}

// ---------------------------------------------------------------------------
// Checking a file
// ---------------------------------------------------------------------------

export interface CheckOptions {
  /** Declarations whose axioms to report; each gets an `#print axioms` line. */
  decls?: string[];
  /** Directories holding `.olean` files the source imports. */
  leanPath?: string[];
  /** Directory to run in — elan picks the toolchain from here. */
  cwd?: string;
  timeoutMs: number;
}

export interface CheckResult {
  compiled: boolean;
  timedOut: boolean;
  exitCode: number | null;
  errors: Diagnostic[];
  warnings: Diagnostic[];
  sorryWarnings: number;
  /** Per requested declaration: its axioms, or null when Lean did not find it. */
  axioms: Record<string, string[] | null>;
  /** Compiled, no errors, and no requested declaration rests on `sorryAx`. */
  kernelAccepted: boolean;
  theorems: string[];
  textualSorries: number;
  elapsedMs: number;
  /** stderr, when Lean wrote any (a crash, a missing toolchain). */
  stderr?: string;
}

const NAME = /^[\p{L}_][\p{L}\p{N}_'!?.«»]*$/u;

export function leanEnv(leanPath: string[] | undefined): NodeJS.ProcessEnv {
  if (!leanPath?.length) return process.env;
  const existing = process.env.LEAN_PATH;
  return { ...process.env, LEAN_PATH: [...leanPath, ...(existing ? [existing] : [])].join(delimiter) };
}

/**
 * Compile one Lean source with `lean --json`, asking for the axioms of `decls`.
 *
 * The source is copied to a scratch file with the `#print axioms` lines
 * appended, so the file being checked is never modified. Its imports resolve
 * through `leanPath`, which must hold already-built `.olean` files.
 */
export async function checkSource(source: string, options: CheckOptions): Promise<CheckResult> {
  const decls = options.decls ?? [];
  for (const decl of decls) {
    if (!NAME.test(decl)) throw new RangeError(`not a Lean declaration name: ${JSON.stringify(decl)}`);
  }

  const dir = mkdtempSync(join(tmpdir(), 'lean-link-'));
  const file = join(dir, 'Check.lean');
  try {
    const appended = decls.map((d) => `\n#print axioms ${d}`).join('');
    writeFileSync(file, source + (appended ? `\n${appended}\n` : ''), 'utf8');
    const result = await runProcess('lean', ['--json', file], {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      env: leanEnv(options.leanPath),
      timeoutMs: options.timeoutMs,
    });
    return summarise(source, decls, result);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function checkFile(path: string, options: CheckOptions): Promise<CheckResult> {
  return checkSource(readFileSync(path, 'utf8'), options);
}

function summarise(source: string, decls: string[], result: ProcessResult): CheckResult {
  const messages = parseJsonMessages(result.stdout);
  const errors = messages.filter((m) => m.severity === 'error');
  const warnings = messages.filter((m) => m.severity === 'warning');

  const axioms: Record<string, string[] | null> = Object.fromEntries(decls.map((d) => [d, null]));
  for (const m of messages) {
    const parsed = m.severity === 'information' ? parseAxioms(m.message) : null;
    if (!parsed) continue;
    // Lean prints the name as resolved; match on suffix so `foo` finds `Ns.foo` under `open Ns`.
    const key = decls.find((d) => parsed.decl === d || parsed.decl.endsWith(`.${d}`));
    if (key) axioms[key] = parsed.axioms;
  }

  const compiled = result.exitCode === 0 && !result.timedOut && errors.length === 0;
  const kernelAccepted =
    compiled && decls.every((d) => axioms[d] !== null && !axioms[d]!.includes('sorryAx'));

  const out: CheckResult = {
    compiled,
    timedOut: result.timedOut,
    exitCode: result.exitCode,
    errors,
    warnings,
    sorryWarnings: warnings.filter(isSorryWarning).length,
    axioms,
    kernelAccepted,
    theorems: declaredTheorems(source),
    textualSorries: textualSorries(source),
    elapsedMs: result.elapsedMs,
  };
  if (result.stderr.trim()) out.stderr = result.stderr.trim();
  return out;
}
