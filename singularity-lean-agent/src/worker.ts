/**
 * Building a lean-worker checkout, as its sources actually are.
 *
 * At the pinned commit, lean-worker cannot be built the way its README says.
 * Every module imports its siblings as `RequestProject.X`, but the files sit
 * flat in `minimal/` with no `RequestProject/` directory; `lakefile.toml` names
 * a library `Minimal` whose roots don't carry that prefix; and `Main.lean`
 * imports all of Mathlib for nothing it uses. `lake build` and `lean *.lean`
 * both fail on the first import.
 *
 * The sources themselves are fine. Staged into the layout their imports
 * expect, and compiled leaf-first, the twin model, the protocol layer and the
 * proxy layer all build under the pinned toolchain without Mathlib. So that is
 * what this does: copy (never modify) the checkout into a stage directory,
 * order the modules by their imports, and compile each with `lean -o`.
 *
 * Per-module results are the kernel's, not a grep's. Upstream counts theorems
 * with `grep -c "^theorem"` and sorries with `grep -c "by sorry"`; the 45
 * plugin contexts pass that count with zero sorries and do not compile.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import { type Diagnostic, declaredTheorems, isSorryWarning, leanEnv, parseJsonMessages, runProcess } from './lean.js';

export const MODULE_PREFIX = 'RequestProject';

export interface StagedModule {
  /** e.g. `RequestProject.Protocol.Server`. */
  module: string;
  /** Path inside the checkout, e.g. `minimal/Protocol/Server.lean`. */
  source: string;
  /** Path inside the stage directory. */
  staged: string;
  imports: string[];
  group: 'core' | 'protocol' | 'proxy' | 'plugin-context' | 'entry';
}

export interface Stage {
  checkout: string;
  dir: string;
  /** Where `.olean` files go; this is the `LEAN_PATH` for anything importing them. */
  out: string;
  modules: StagedModule[];
  toolchain: string | null;
}

/** `minimal/` files that are entry points rather than library modules. */
const ENTRY = new Set(['Main.lean', 'ProxyReport.lean']);

function importsOf(source: string): string[] {
  const header = source.replace(/\/-[\s\S]*?-\//g, '').replace(/--.*$/gm, '');
  return [...header.matchAll(/^\s*import\s+([A-Za-z0-9_.«»]+)/gm)].map((m) => m[1]!);
}

function leanFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.lean') && statSync(join(dir, f)).isFile());
}

/**
 * Copy a checkout into `stageDir` under `RequestProject/`.
 *
 * Plugin contexts are taken from `contexts/plugins/` (their canonical home in
 * the agent-c task) when present, and from the copies in `minimal/` otherwise,
 * so each is built once.
 */
export function stageWorker(checkout: string, stageDir: string): Stage {
  const minimal = join(checkout, 'minimal');
  if (!existsSync(minimal)) {
    throw new Error(`${checkout} does not look like a lean-worker checkout: there is no minimal/ directory`);
  }

  const contextsDir = join(checkout, 'contexts', 'plugins');
  const contextNames = new Set(leanFiles(contextsDir));
  const modules: StagedModule[] = [];

  const add = (sourcePath: string, relModule: string[], group: StagedModule['group']) => {
    const staged = join(stageDir, MODULE_PREFIX, ...relModule) + '.lean';
    mkdirSync(dirname(staged), { recursive: true });
    copyFileSync(sourcePath, staged);
    modules.push({
      module: [MODULE_PREFIX, ...relModule].join('.'),
      source: relative(checkout, sourcePath).split(sep).join('/'),
      staged,
      imports: importsOf(readFileSync(sourcePath, 'utf8')),
      group,
    });
  };

  for (const file of leanFiles(minimal)) {
    const name = basename(file, '.lean');
    if (ENTRY.has(file)) add(join(minimal, file), [name], 'entry');
    else if (/^[A-Z]/.test(name)) add(join(minimal, file), [name], 'core');
    else if (!contextNames.has(file)) add(join(minimal, file), [name], 'plugin-context');
  }
  for (const sub of ['Protocol', 'Proxy'] as const) {
    for (const file of leanFiles(join(minimal, sub))) {
      add(join(minimal, sub, file), [sub, basename(file, '.lean')], sub === 'Protocol' ? 'protocol' : 'proxy');
    }
  }
  for (const file of contextNames) add(join(contextsDir, file), [basename(file, '.lean')], 'plugin-context');

  const toolchainFile = join(minimal, 'lean-toolchain');
  const toolchain = existsSync(toolchainFile) ? readFileSync(toolchainFile, 'utf8').trim() : null;
  mkdirSync(stageDir, { recursive: true });
  // elan reads this, so every `lean` below runs the toolchain upstream pinned.
  if (toolchain) writeFileSync(join(stageDir, 'lean-toolchain'), toolchain + '\n');

  const out = join(stageDir, 'out');
  mkdirSync(out, { recursive: true });
  return { checkout, dir: stageDir, out, modules, toolchain };
}

/** Modules in an order where every import comes first. Cycles are reported, not looped on. */
export function buildOrder(modules: StagedModule[]): { order: StagedModule[]; cyclic: string[] } {
  const byName = new Map(modules.map((m) => [m.module, m]));
  const state = new Map<string, 'visiting' | 'done'>();
  const order: StagedModule[] = [];
  const cyclic: string[] = [];

  const visit = (m: StagedModule) => {
    const s = state.get(m.module);
    if (s === 'done') return;
    if (s === 'visiting') {
      cyclic.push(m.module);
      return;
    }
    state.set(m.module, 'visiting');
    for (const imp of m.imports) {
      const dep = byName.get(imp);
      if (dep) visit(dep);
    }
    state.set(m.module, 'done');
    order.push(m);
  };
  for (const m of [...modules].sort((a, b) => a.module.localeCompare(b.module))) visit(m);
  return { order, cyclic };
}

export type ModuleStatus = 'ok' | 'failed' | 'skipped';

export interface ModuleResult {
  module: string;
  source: string;
  group: StagedModule['group'];
  status: ModuleStatus;
  /** Why it was skipped: an external import we do not provide, or a dependency that failed. */
  reason?: string;
  theorems: number;
  sorryWarnings: number;
  errors: Diagnostic[];
  warnings: number;
  elapsedMs: number;
}

export interface BuildReport {
  checkout: string;
  toolchain: string | null;
  modules: ModuleResult[];
  summary: {
    ok: number;
    failed: number;
    skipped: number;
    /** Theorems in modules that compiled with no `sorry`. */
    theoremsKernelChecked: number;
    sorryWarnings: number;
  };
  byGroup: Record<StagedModule['group'], { ok: number; failed: number; skipped: number }>;
}

/** Imports that are part of every Lean toolchain. */
const BUILTIN = /^(Init|Std|Lean|Lake)(\.|$)/;

export interface BuildOptions {
  /** Seconds per module. */
  moduleTimeoutSeconds?: number;
  /** Only build these groups (plus whatever they import). */
  groups?: Array<StagedModule['group']>;
  onModule?: (result: ModuleResult) => void;
}

export async function buildStage(stage: Stage, options: BuildOptions = {}): Promise<BuildReport> {
  const timeoutMs = (options.moduleTimeoutSeconds ?? 600) * 1000;
  const { order } = buildOrder(stage.modules);
  const wanted = options.groups ? closure(stage.modules, options.groups) : null;
  const known = new Set(stage.modules.map((m) => m.module));
  const results = new Map<string, ModuleResult>();

  for (const m of order) {
    if (wanted && !wanted.has(m.module)) continue;
    const base = { module: m.module, source: m.source, group: m.group, theorems: declaredTheorems(readFileSync(m.staged, 'utf8')).length };
    const external = m.imports.filter((i) => !known.has(i) && !BUILTIN.test(i));
    const brokenDep = m.imports.find((i) => known.has(i) && results.get(i)?.status !== 'ok');

    let result: ModuleResult;
    if (external.length) {
      result = { ...base, status: 'skipped', reason: `imports ${external.join(', ')}, which this build does not provide`, sorryWarnings: 0, errors: [], warnings: 0, elapsedMs: 0 };
    } else if (brokenDep) {
      result = { ...base, status: 'skipped', reason: `depends on ${brokenDep}, which did not build`, sorryWarnings: 0, errors: [], warnings: 0, elapsedMs: 0 };
    } else {
      const olean = join(stage.out, ...m.module.split('.')) + '.olean';
      mkdirSync(dirname(olean), { recursive: true });
      const rel = relative(stage.dir, m.staged);
      const run = await runProcess('lean', ['--json', '-o', olean, rel], { cwd: stage.dir, env: leanEnv([stage.out]), timeoutMs });
      const messages = parseJsonMessages(run.stdout);
      const errors = messages.filter((d) => d.severity === 'error');
      if (run.timedOut) errors.push({ severity: 'error', line: 0, column: 0, message: `timed out after ${timeoutMs / 1000}s` });
      if (run.exitCode === null && !run.timedOut) errors.push({ severity: 'error', line: 0, column: 0, message: run.stderr.trim() || 'lean did not start' });
      const warnings = messages.filter((d) => d.severity === 'warning');
      result = {
        ...base,
        status: run.exitCode === 0 && errors.length === 0 ? 'ok' : 'failed',
        sorryWarnings: warnings.filter(isSorryWarning).length,
        errors: errors.slice(0, 20),
        warnings: warnings.length,
        elapsedMs: run.elapsedMs,
      };
    }
    results.set(m.module, result);
    options.onModule?.(result);
  }

  const modules = [...results.values()];
  const byGroup = {} as BuildReport['byGroup'];
  for (const g of ['core', 'protocol', 'proxy', 'plugin-context', 'entry'] as const) {
    const inGroup = modules.filter((m) => m.group === g);
    byGroup[g] = {
      ok: inGroup.filter((m) => m.status === 'ok').length,
      failed: inGroup.filter((m) => m.status === 'failed').length,
      skipped: inGroup.filter((m) => m.status === 'skipped').length,
    };
  }
  return {
    checkout: stage.checkout,
    toolchain: stage.toolchain,
    modules,
    summary: {
      ok: modules.filter((m) => m.status === 'ok').length,
      failed: modules.filter((m) => m.status === 'failed').length,
      skipped: modules.filter((m) => m.status === 'skipped').length,
      theoremsKernelChecked: modules.filter((m) => m.status === 'ok' && m.sorryWarnings === 0).reduce((n, m) => n + m.theorems, 0),
      sorryWarnings: modules.reduce((n, m) => n + m.sorryWarnings, 0),
    },
    byGroup,
  };
}

function closure(modules: StagedModule[], groups: Array<StagedModule['group']>): Set<string> {
  const byName = new Map(modules.map((m) => [m.module, m]));
  const keep = new Set<string>();
  const add = (name: string) => {
    if (keep.has(name)) return;
    const m = byName.get(name);
    if (!m) return;
    keep.add(name);
    m.imports.forEach(add);
  };
  modules.filter((m) => groups.includes(m.group)).forEach((m) => add(m.module));
  return keep;
}

/** Find the staged source of a module, for proving a goal in it. */
export function moduleSource(stage: Stage, module: string): StagedModule | undefined {
  return stage.modules.find((m) => m.module === module);
}
