import { describe, it, expect, vi } from 'vitest';
import {
  TOOLS,
  anthropicTools,
  createExecutor,
  functionTools,
  mcpTools,
  runTool,
  selectTools,
} from '../src/tools.js';
import { operations } from 'singularity-agent';

/**
 * The bridge, tested for the one property it exists to have: no second copy.
 *
 * Every assertion below is written against the catalogue rather than against a
 * hardcoded list of tool names, so adding a tool cannot leave one shape behind.
 * A test that says `expect(tools).toHaveLength(16)` would pass forever and
 * catch nothing.
 */

describe('every shape is derived from one catalogue', () => {
  it('exposes the same tools, by name, in all three shapes', () => {
    const names = TOOLS.map((t) => t.name);

    expect(anthropicTools().map((t) => t.name)).toEqual(names);
    expect(functionTools().map((t) => t.function.name)).toEqual(names);
    expect(mcpTools().map((t) => t.name)).toEqual(names);
  });

  it('carries each description through unchanged, rather than re-wording it', () => {
    for (const tool of TOOLS) {
      const anthropic = anthropicTools().find((t) => t.name === tool.name);
      const fn = functionTools().find((t) => t.function.name === tool.name);
      const mcp = mcpTools().find((t) => t.name === tool.name);

      expect(anthropic?.description).toBe(tool.description);
      expect(fn?.function.description).toBe(tool.description);
      expect(mcp?.description).toBe(tool.description);
    }
  });

  it('gives every tool a real object schema, never an empty one', () => {
    // An empty schema reads to a model as "this takes anything", which is the
    // failure the core's converter throws about rather than emitting.
    for (const tool of anthropicTools()) {
      expect(tool.input_schema['type'], tool.name).toBe('object');
      expect(tool.input_schema['properties'], tool.name).toBeTruthy();
    }
  });

  it('carries the read-only annotation rather than asserting it', () => {
    for (const tool of mcpTools()) {
      expect(tool.annotations.readOnlyHint, tool.name).toBe(true);
    }
  });

  it('offers no tool that writes', () => {
    // `redeem_burn` is deliberately absent from the catalogue: it writes, and
    // it should be something an operator decides rather than something a model
    // reaches for mid-sentence. If it ever appears here, that was a decision.
    const names = TOOLS.map((t) => t.name);
    expect(names).not.toContain('redeem_burn');
    expect(TOOLS.every((t) => t.annotations.readOnlyHint)).toBe(true);
  });
});

describe('selection', () => {
  it('narrows with `only` and `except`', () => {
    expect(selectTools({ only: ['balance', 'chains'] }).map((t) => t.name)).toEqual([
      'chains',
      'balance',
    ]);

    expect(selectTools({ except: ['decode'] }).map((t) => t.name)).not.toContain('decode');
  });

  it('applies `except` after `only`', () => {
    expect(
      selectTools({ only: ['balance', 'chains'], except: ['chains'] }).map((t) => t.name),
    ).toEqual(['balance']);
  });

  it('returns everything when nothing is selected', () => {
    expect(selectTools()).toHaveLength(TOOLS.length);
    expect(selectTools({})).toHaveLength(TOOLS.length);
  });
});

describe('running a tool', () => {
  it('validates arguments before the operation sees them', async () => {
    // The catalogue's own `run` casts rather than parses, because MCP validates
    // on the way in. Nothing validates on this path, and the caller is a model
    // improvising JSON — so `limit: "ten"` has to stop here rather than reach
    // an RPC call as NaN.
    const result = await runTool('history', { address: '0x1', chain: 'ethereum', limit: 'ten' });

    expect(result.isError).toBe(true);
    expect(result.error?.code).toBe('BAD_ARGUMENTS');
    expect(result.error?.message).toMatch(/limit/);
  });

  it('reports a missing required argument by name', async () => {
    const result = await runTool('balance', { chain: 'ethereum' });

    expect(result.isError).toBe(true);
    expect(result.error?.code).toBe('BAD_ARGUMENTS');
    expect(result.error?.message).toMatch(/address/);
  });

  it('names an unknown tool and lists the real ones', async () => {
    const result = await runTool('transfer_everything', {});

    expect(result.isError).toBe(true);
    expect(result.error?.code).toBe('UNKNOWN_TOOL');
    expect(result.error?.hint).toContain('balance');
  });

  it('returns a failure as a value, with the hint intact', async () => {
    // A model that sees a thrown exception sees a crashed turn. The hints in
    // this codebase are written for exactly this reader, so losing them is the
    // expensive half of the mistake.
    vi.spyOn(operations, 'getBalance').mockRejectedValueOnce(
      Object.assign(new Error('Not a valid Ethereum address.'), {
        code: 'INVALID_ADDRESS',
        hint: 'Ethereum addresses are 0x followed by 40 hex characters.',
      }),
    );

    const result = await runTool('balance', { address: 'nope', chain: 'ethereum' });

    expect(result.isError).toBe(true);
    expect(result.error?.code).toBe('INVALID_ADDRESS');
    expect(result.error?.hint).toMatch(/40 hex characters/);
    vi.restoreAllMocks();
  });

  it('passes a successful result through untouched, envelope and all', async () => {
    const answer = {
      chain: 'ethereum',
      tokens: [],
      tokenCompleteness: { kind: 'curated', note: 'a known subset was checked' },
    };
    vi.spyOn(operations, 'getBalance').mockResolvedValueOnce(answer as never);

    const result = await runTool('balance', { address: '0x1', chain: 'ethereum' });

    expect(result.isError).toBe(false);
    // Not re-serialized, not summarized, not stripped of its completeness.
    expect(result.result).toBe(answer);
    vi.restoreAllMocks();
  });

  it('runs a real read end to end', async () => {
    const result = await runTool('chains', { family: 'svm' });

    expect(result.isError).toBe(false);
    expect(Array.isArray(result.result)).toBe(true);
    expect((result.result as Array<{ family: string }>).every((c) => c.family === 'svm')).toBe(true);
  });
});

describe('the executor', () => {
  it('refuses a filtered-out tool by name, not merely by omitting it', async () => {
    // A model can name a tool it was never offered — from its training, or
    // from earlier in the same conversation. A filter that only shortens a
    // list is not a filter.
    const agent = createExecutor({ selection: { only: ['chains'] } });
    const result = await agent.run('balance', { address: '0x1', chain: 'ethereum' });

    expect(result.isError).toBe(true);
    expect(result.error?.code).toBe('TOOL_NOT_AVAILABLE');
    expect(result.error?.hint).toContain('chains');
  });

  it('lets `before` rewrite arguments', async () => {
    const getHistory = vi.spyOn(operations, 'getHistory').mockResolvedValue({
      chain: 'ethereum',
      address: '0x1',
      entries: [],
      completeness: { kind: 'exhaustive', note: '' },
    } as never);

    const agent = createExecutor({
      before: (name, input) => (name === 'history' ? { ...input, limit: 50 } : undefined),
    });

    await agent.run('history', { address: '0x1', chain: 'ethereum', limit: 5_000 });

    expect(getHistory).toHaveBeenCalledWith(expect.objectContaining({ limit: 50 }));
    vi.restoreAllMocks();
  });

  it('lets `before` refuse, and the tool never runs', async () => {
    const getBalance = vi.spyOn(operations, 'getBalance');

    const agent = createExecutor({
      before(name) {
        if (name === 'balance') {
          throw Object.assign(new Error('Balances are not available in this app.'), { code: 'POLICY' });
        }
      },
    });

    const result = await agent.run('balance', { address: '0x1', chain: 'ethereum' });

    expect(result.isError).toBe(true);
    expect(result.error?.code).toBe('POLICY');
    expect(getBalance).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('calls `after` on both outcomes, including a refusal', async () => {
    const after = vi.fn();
    const agent = createExecutor({
      selection: { only: ['chains'] },
      before(name) {
        if (name === 'chains') throw new Error('no');
      },
      after,
    });

    await agent.run('chains', {});
    await agent.run('balance', {});

    expect(after).toHaveBeenCalledTimes(2);
    expect(after.mock.calls.every(([r]) => (r as { isError: boolean }).isError)).toBe(true);
  });

  it('serves its own filtered set in every shape', () => {
    const agent = createExecutor({ selection: { only: ['chains', 'balance'] } });

    expect(agent.tools.map((t) => t.name)).toEqual(['chains', 'balance']);
    expect(agent.anthropic().map((t) => t.name)).toEqual(['chains', 'balance']);
    expect(agent.functions().map((t) => t.function.name)).toEqual(['chains', 'balance']);
  });
});
