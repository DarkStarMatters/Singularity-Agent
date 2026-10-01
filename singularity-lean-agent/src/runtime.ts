/**
 * The real back end behind a prover node: `P2P.Runtime`, with Lean in it.
 *
 *  - `proveGoal` checks that the module's source on this node has the digest
 *    the caller named (so both sides are talking about the same text), compiles
 *    it with `#print axioms` for the declaration, and reports `proved(axioms)`
 *    only when the kernel accepted it with no `sorryAx`. The checked source is
 *    kept as an artifact under its digest.
 *  - `checkProof` re-checks such an artifact from scratch.
 *  - `runExe` (lake projects only, and only when policy allows it) builds the
 *    executable with `lake build` and runs it. `kernelChecked` there means the
 *    build — which elaborates and kernel-checks every module the executable is
 *    made from — succeeded; it says nothing about what the program prints.
 *
 * Fuel is seconds of wall-clock time; a job that runs out is a `failed` outcome
 * and still costs the caller everything it asked for, as upstream charges it.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type CheckResult, checkSource, runProcess } from './lean.js';
import type { RunResult, Runtime } from './node.js';
import { linkHome, type Project } from './store.js';
import { type Call, type Job, sha256Hex } from './wire.js';
import { type Stage, buildStage, moduleSource, stageWorker } from './worker.js';

const MODULE = /^[A-Za-z_][A-Za-z0-9_'.]*$/;

/** `lake env` puts these on LEAN_PATH; computed here so a node needs no shell. */
export function lakeLeanPath(root: string): string[] {
  const out = [join(root, '.lake', 'build', 'lib', 'lean')];
  const packages = join(root, '.lake', 'packages');
  if (existsSync(packages)) {
    for (const pkg of readdirSync(packages)) out.push(join(packages, pkg, '.lake', 'build', 'lib', 'lean'));
  }
  return out;
}

interface Located {
  source: string;
  leanPath: string[];
  cwd: string;
}

function failedOutcome(check: CheckResult, decl: string): string {
  if (check.timedOut) return 'out of fuel: the check did not finish in time';
  const first = check.errors[0];
  if (first) return `error at ${first.line}:${first.column}: ${first.message}`.slice(0, 1000);
  if (check.axioms[decl] === null) return `declaration ${decl} not found`;
  if (check.axioms[decl]?.includes('sorryAx')) return `${decl} depends on sorryAx`;
  return `lean exited with code ${check.exitCode}`;
}

export class LeanRuntime implements Runtime {
  private stage: Stage | null = null;
  private readonly artifacts: string;

  constructor(private readonly project: Project, home = linkHome()) {
    this.artifacts = join(home, 'artifacts');
  }

  /** Stage and build a lean-worker checkout's library once, before serving. */
  async prepare(onProgress?: (line: string) => void): Promise<void> {
    if (this.project.kind !== 'lean-worker') return;
    this.stage = stageWorker(this.project.checkout, join(linkHome(), 'stage'));
    const report = await buildStage(this.stage, {
      groups: ['core', 'protocol', 'proxy'],
      onModule: (m) => onProgress?.(`${m.status.padEnd(7)} ${m.module}`),
    });
    onProgress?.(`built ${report.summary.ok} modules, ${report.summary.failed} failed, ${report.summary.skipped} skipped`);
  }

  private locate(module: string): Located | { error: string } {
    if (!MODULE.test(module)) return { error: `not a module name: ${module}` };
    if (this.project.kind === 'lake') {
      const path = join(this.project.root, ...module.split('.')) + '.lean';
      if (!existsSync(path)) return { error: `module ${module} not found on this node` };
      return { source: readFileSync(path, 'utf8'), leanPath: lakeLeanPath(this.project.root), cwd: this.project.root };
    }
    if (!this.stage) return { error: 'this node has not built its lean-worker checkout yet' };
    const staged = moduleSource(this.stage, module);
    if (!staged) return { error: `module ${module} not found on this node` };
    return { source: readFileSync(staged.staged, 'utf8'), leanPath: [this.stage.out], cwd: this.stage.dir };
  }

  async run(job: Job, fuelSeconds: number, call: Call): Promise<RunResult> {
    const timeoutMs = Math.max(1, fuelSeconds) * 1000;
    switch (job.kind) {
      case 'proveGoal': {
        const found = this.locate(job.module);
        if ('error' in found) return { outcome: { kind: 'failed', reason: found.error }, kernelChecked: false };
        const digest = sha256Hex(found.source);
        if (digest !== job.sourceDigest) {
          return { outcome: { kind: 'failed', reason: `source digest mismatch: this node has ${digest}` }, kernelChecked: false };
        }
        const check = await checkSource(found.source, { decls: [job.decl], leanPath: found.leanPath, cwd: found.cwd, timeoutMs });
        if (!check.kernelAccepted) return { outcome: { kind: 'failed', reason: failedOutcome(check, job.decl) }, kernelChecked: false };
        this.keepArtifact(digest, found.source, { module: job.module, decl: job.decl });
        return { outcome: { kind: 'proved', axioms: check.axioms[job.decl] ?? [] }, kernelChecked: true };
      }

      case 'checkProof': {
        const artifact = this.readArtifact(job.artifactDigest);
        if (!artifact) return { outcome: { kind: 'failed', reason: 'no artifact with that digest on this node' }, kernelChecked: false };
        const found = this.locate(artifact.meta.module);
        if ('error' in found) return { outcome: { kind: 'failed', reason: found.error }, kernelChecked: false };
        const check = await checkSource(artifact.source, { decls: [artifact.meta.decl], leanPath: found.leanPath, cwd: found.cwd, timeoutMs });
        if (!check.kernelAccepted) return { outcome: { kind: 'failed', reason: failedOutcome(check, artifact.meta.decl) }, kernelChecked: false };
        return { outcome: { kind: 'proved', axioms: check.axioms[artifact.meta.decl] ?? [] }, kernelChecked: true };
      }

      case 'runExe': {
        if (this.project.kind !== 'lake') {
          return { outcome: { kind: 'failed', reason: 'runExe needs a lake project; lean-worker has no buildable executable' }, kernelChecked: false };
        }
        const root = this.project.root;
        const started = Date.now();
        const build = await runProcess('lake', ['build', job.exe], { cwd: root, timeoutMs });
        if (build.exitCode !== 0) {
          return { outcome: { kind: 'failed', reason: build.timedOut ? 'out of fuel during lake build' : `lake build ${job.exe} failed` }, kernelChecked: false };
        }
        const bin = join(root, '.lake', 'build', 'bin', process.platform === 'win32' ? `${job.exe}.exe` : job.exe);
        const remaining = Math.max(1000, timeoutMs - (Date.now() - started));
        const ran = await runProcess(bin, call.argv ?? [], { cwd: root, timeoutMs: remaining });
        if (ran.timedOut) return { outcome: { kind: 'failed', reason: 'out of fuel while running' }, kernelChecked: true };
        if (ran.exitCode === null) return { outcome: { kind: 'failed', reason: `could not start ${job.exe}` }, kernelChecked: true };
        return { outcome: { kind: 'exited', code: ran.exitCode, outDigest: sha256Hex(ran.stdout) }, kernelChecked: true };
      }
    }
  }

  private keepArtifact(digest: string, source: string, meta: { module: string; decl: string }): void {
    mkdirSync(this.artifacts, { recursive: true });
    writeFileSync(join(this.artifacts, `${digest}.lean`), source);
    writeFileSync(join(this.artifacts, `${digest}.json`), JSON.stringify(meta) + '\n');
  }

  private readArtifact(digest: string): { source: string; meta: { module: string; decl: string } } | null {
    const file = join(this.artifacts, `${digest}.lean`);
    if (!/^[0-9a-f]{64}$/.test(digest) || !existsSync(file)) return null;
    const source = readFileSync(file, 'utf8');
    if (sha256Hex(source) !== digest) return null;
    return { source, meta: JSON.parse(readFileSync(join(this.artifacts, `${digest}.json`), 'utf8')) as { module: string; decl: string } };
  }
}
