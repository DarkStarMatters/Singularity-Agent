import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { checkSource, declaredTheorems, parseAxioms, parseJsonMessages, textualSorries } from '../src/lean.js';
import { buildOrder, buildStage, stageWorker } from '../src/worker.js';

/** Lines captured from `lean --json` 4.34.1 — the shapes the parser has to read. */
const CAPTURED = [
  '{"caption":"","data":"declaration uses `sorry`","endPos":{"column":11,"line":3},"fileName":"t.lean","isSilent":false,"keepFullRange":false,"kind":"hasSorry","pos":{"column":8,"line":3},"severity":"warning"}',
  '{"caption":"","data":"Tactic `decide` proved that the proposition\\n  2 = 3\\nis false","endPos":{"column":18,"line":5},"fileName":"t.lean","isSilent":false,"keepFullRange":false,"kind":"[anonymous]","pos":{"column":12,"line":5},"severity":"error"}',
  '{"caption":"","data":"\'foo\' does not depend on any axioms","endPos":{"column":6,"line":7},"fileName":"t.lean","isSilent":false,"keepFullRange":false,"kind":"[anonymous]","pos":{"column":0,"line":7},"severity":"information"}',
  '{"caption":"","data":"\'bar\' depends on axioms: [sorryAx]","endPos":{"column":6,"line":8},"fileName":"t.lean","isSilent":false,"keepFullRange":false,"kind":"[anonymous]","pos":{"column":0,"line":8},"severity":"information"}',
].join('\n');

describe('reading Lean output', () => {
  it('parses --json messages', () => {
    const msgs = parseJsonMessages(CAPTURED);
    expect(msgs.map((m) => m.severity)).toEqual(['warning', 'error', 'information', 'information']);
    expect(msgs[1]).toMatchObject({ line: 5, column: 12 });
  });

  it('reads both shapes of #print axioms, and nothing else', () => {
    expect(parseAxioms("'foo' does not depend on any axioms")).toEqual({ decl: 'foo', axioms: [] });
    expect(parseAxioms("'P2P.x' depends on axioms: [propext, Classical.choice, Quot.sound]")).toEqual({
      decl: 'P2P.x',
      axioms: ['propext', 'Classical.choice', 'Quot.sound'],
    });
    expect(parseAxioms('declaration uses `sorry`')).toBeNull();
  });

  it('finds theorem names the way upstream counts them, without counting comments', () => {
    const src = 'theorem a : True := trivial\n@[simp] theorem b : True := trivial\n  private lemma c : True := trivial\n-- theorem d\n';
    expect(declaredTheorems(src)).toEqual(['a', 'b', 'c']);
    expect(textualSorries('-- sorry\n/- sorry -/\ntheorem x : False := by sorry')).toBe(1);
  });
});

function leanAvailable(): boolean {
  try {
    execFileSync('lean', ['--version'], { stdio: 'ignore', timeout: 120_000 });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!leanAvailable())('against the real compiler', () => {
  it('kernelAccepted is false for sorry, true for a real proof, and axioms are reported', async () => {
    const source = 'theorem good : 2 + 2 = 4 := rfl\ntheorem bad (n : Nat) : n = n + 0 := by sorry\n';
    const r = await checkSource(source, { decls: ['good', 'bad', 'missing'], timeoutMs: 120_000 });
    expect(r.axioms.good).toEqual([]);
    expect(r.axioms.bad).toEqual(['sorryAx']);
    expect(r.axioms.missing).toBeNull();
    expect(r.sorryWarnings).toBe(1);
    expect(r.kernelAccepted).toBe(false);

    const ok = await checkSource(source, { decls: ['good'], timeoutMs: 120_000 });
    // The file still has a sorry, but `good` does not depend on it.
    expect(ok.kernelAccepted).toBe(true);
  }, 180_000);

  it('rejects names that would smuggle commands into the appended #print line', async () => {
    await expect(checkSource('', { decls: ['x\n#eval 1'], timeoutMs: 1000 })).rejects.toThrow(/not a Lean declaration name/);
  });

  it('stages a lean-worker-shaped checkout and builds it leaf-first', async () => {
    const root = mkdtempSync(join(tmpdir(), 'lw-'));
    const minimal = join(root, 'minimal');
    mkdirSync(join(minimal, 'Protocol'), { recursive: true });
    mkdirSync(join(root, 'contexts', 'plugins'), { recursive: true });
    writeFileSync(join(minimal, 'Protocol', 'Core.lean'), 'namespace P\ntheorem base : 1 = 1 := rfl\nend P\n');
    writeFileSync(join(minimal, 'Twin.lean'), 'import RequestProject.Protocol.Core\ntheorem uses : 1 = 1 := P.base\n');
    writeFileSync(join(root, 'contexts', 'plugins', 'broken.lean'), 'import RequestProject.Twin\ntheorem nope : 1 = 2 := by\n  exFalso\n');
    writeFileSync(join(root, 'contexts', 'plugins', 'after.lean'), 'import RequestProject.broken\n');
    writeFileSync(join(minimal, 'Main.lean'), 'import Mathlib\n');

    const stage = stageWorker(root, join(root, '.stage'));
    const names = buildOrder(stage.modules).order.map((m) => m.module);
    expect(names.indexOf('RequestProject.Protocol.Core')).toBeLessThan(names.indexOf('RequestProject.Twin'));

    const report = await buildStage(stage, { groups: ['core', 'protocol', 'plugin-context', 'entry'], moduleTimeoutSeconds: 120 });
    const status = Object.fromEntries(report.modules.map((m) => [m.module, m.status]));
    expect(status).toMatchObject({
      'RequestProject.Protocol.Core': 'ok',
      'RequestProject.Twin': 'ok',
      'RequestProject.broken': 'failed',
      'RequestProject.after': 'skipped',
      'RequestProject.Main': 'skipped',
    });
    expect(report.modules.find((m) => m.module === 'RequestProject.Main')?.reason).toMatch(/Mathlib/);
    expect(report.summary.theoremsKernelChecked).toBe(2);
  }, 300_000);
});
