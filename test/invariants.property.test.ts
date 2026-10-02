import { describe, it, expect, vi, beforeEach } from 'vitest';
import fc from 'fast-check';
import type { Completeness, CompletenessKind } from '../src/core/envelope.js';
import {
  checkCut,
  checkFailedRead,
  checkNotFoundClaim,
  checkNotStronger,
  checkSearched,
  checkShape,
  type SearchRecord,
  type Violation,
} from '../src/core/invariants.js';

/**
 * Every adapter-routed tool, against adapters that fail in every way they can.
 *
 * The five violations in the roadmap's Phase 7 were each caught by a person
 * after one example test had passed. This file is the other approach: generate
 * what the adapters do (answer, answer with nothing, answer with a cut list,
 * time out, say "not here", lose a pruned height), run each tool through its
 * catalogue entry exactly as the MCP server does, and hold the output to the
 * invariants in `src/core/invariants.ts`. A tool that swallows a rejection or
 * strengthens a caveat fails here without anyone having written a test for
 * that particular swallow, and fast-check shrinks the failure to the smallest
 * world that shows it.
 *
 * The adapters are fakes, so this tests what the operations layer does with an
 * adapter's answer, not whether an adapter reads a chain correctly. That is
 * where four of the five lived: between a correct read and a wrong claim.
 */

type Fault = 'network' | 'absent';

interface ChainWorld {
  native: { ok: true; raw: bigint } | { ok: false };
  tokens: { ok: false } | { ok: true; kind: CompletenessKind; count: number; omitted: number; raws: bigint[] };
  tx: 'found' | Fault;
  history: 'missing' | { ok: false } | { ok: true; kind: CompletenessKind; count: number };
  head: 'ok' | 'fail' | 'undated';
  finalized: 'ok' | 'none' | 'fail';
  block: boolean;
  fees: boolean;
  /** Indexed by block height mod length, so every height has one fate. */
  pastReads: Array<'ok' | 'pruned' | 'fail'>;
  pastUnsupported: boolean;
  /** One per configured endpoint, for liveness. */
  endpoints: Array<'fresh' | 'stale' | 'undated' | 'fail'>;
  /** What a forward name lookup does: an address, no record, or a failed read. */
  name: 'resolves' | 'none' | 'fail';
  /** The same for a reverse lookup, which `resolve` treats as a nicety. */
  reverse: 'name' | 'none' | 'fail';
  contract: boolean;
}

const state = vi.hoisted(() => ({
  world: {} as Record<string, unknown>,
  /** Chain ids each method was called for, in order. */
  calls: [] as Array<{ method: string; chain: string; block?: number }>,
}));

const HEAD = 1_000_000;
/** Where a name resolves, when it resolves. Not either of ADDRESSES. */
const NAMED = '0x1111111111111111111111111111111111111111';
const NOW = () => new Date().toISOString();

vi.mock('../src/adapters/index.js', async () => {
  const { SingularityError, HistoricalStateUnavailableError, HistoricalStateUnsupportedError } = await import('../src/core/errors.js');
  const { amount } = await import('../src/core/format.js');
  const { completeness } = await import('../src/core/envelope.js');

  const fail = (chain: string, what: string) => new Error(`${chain}: ${what} timed out`);

  const fake = (spec: { id: string; rpc: string[]; family: string }) => {
    const w = state.world[spec.id] as ChainWorld | undefined;
    if (!w) throw new Error(`No world for ${spec.id}`);
    const log = (method: string, block?: number) => state.calls.push({ method, chain: spec.id, ...(block === undefined ? {} : { block }) });

    const tokenEntries = (address: string, raws: bigint[]) =>
      raws.map((raw, i) => ({
        chain: spec.id,
        address,
        token: { symbol: `TK${i}`, name: `Token ${i}`, decimals: 6, native: false, address: `0x${String(i).padStart(40, '0')}` },
        amount: amount(raw, 6, `TK${i}`),
      }));

    const adapter: Record<string, unknown> = {
      family: spec.family,
      isValidAddress: (_c: unknown, a: string) => /^0x[0-9a-fA-F]{40}$/.test(a),
      addressExpectation: () => 'Expected 0x and 40 hex characters.',
      async resolveName() {
        log('resolveName');
        if (w.name === 'fail') throw fail(spec.id, 'name lookup');
        return w.name === 'resolves' ? NAMED : null;
      },
      async lookupName() {
        if (w.reverse === 'fail') throw fail(spec.id, 'reverse lookup');
        return w.reverse === 'name' ? 'fake.eth' : null;
      },

      async getNativeBalance(_c: unknown, address: string, options?: { atBlock?: number }) {
        if (options?.atBlock !== undefined) {
          log('getNativeBalance@', options.atBlock);
          if (w.pastUnsupported) throw new HistoricalStateUnsupportedError(spec.id, 'No past state here.');
          const fate = w.pastReads[options.atBlock % w.pastReads.length]!;
          if (fate === 'pruned') throw new HistoricalStateUnavailableError(spec.id, options.atBlock, 'Pruned.');
          if (fate === 'fail') throw fail(spec.id, 'archive read');
          return { chain: spec.id, address, token: { symbol: 'ETH', name: 'Ether', decimals: 18, native: true }, amount: amount(BigInt(options.atBlock), 18, 'ETH'), atBlock: options.atBlock };
        }
        log('getNativeBalance');
        if (!w.native.ok) throw fail(spec.id, 'balance');
        return { chain: spec.id, address, token: { symbol: 'ETH', name: 'Ether', decimals: 18, native: true }, amount: amount(w.native.raw, 18, 'ETH') };
      },

      async getTokenBalances(_c: unknown, address: string) {
        log('getTokenBalances');
        if (!w.tokens.ok) throw fail(spec.id, 'token scan');
        const t = w.tokens;
        const entries = tokenEntries(address, t.raws.slice(0, t.count));
        const c: Completeness =
          t.kind === 'truncated'
            ? completeness.truncated(entries.length, t.omitted, 'Cut by the fake.')
            : { kind: t.kind, note: `The fake says ${t.kind}.` };
        return { entries, completeness: c };
      },

      async getTransaction(_c: unknown, hash: string) {
        log('getTransaction');
        if (w.tx === 'network') throw fail(spec.id, 'getTransaction');
        if (w.tx === 'absent') throw new SingularityError('TX_NOT_FOUND', `Not on ${spec.id}.`);
        return { chain: spec.id, hash, status: 'success', blockNumber: HEAD - 10, summary: 'A transfer.' };
      },

      async getBlock(_c: unknown, ref: string | number) {
        log('getBlock', typeof ref === 'number' ? ref : undefined);
        if (ref === 'latest') {
          if (w.head === 'fail') throw fail(spec.id, 'head');
          return { chain: spec.id, number: HEAD, hash: '0xhead', txCount: 1, ...(w.head === 'ok' ? { timestamp: NOW() } : {}) };
        }
        if (!w.block) throw fail(spec.id, 'getBlock');
        return { chain: spec.id, number: typeof ref === 'number' ? ref : HEAD, hash: '0xblock', txCount: 3, timestamp: NOW() };
      },

      async chainTip(target: { rpc: string[] }) {
        // Liveness isolates one endpoint per probe; everything else asks the chain.
        const index = target.rpc.length === 1 ? spec.rpc.indexOf(target.rpc[0]!) : -1;
        if (index >= 0 && target.rpc.length === 1 && spec.rpc.length > 1) {
          const fate = w.endpoints[index] ?? 'fail';
          if (fate === 'fail') throw fail(spec.id, 'endpoint');
          if (fate === 'undated') return { height: HEAD };
          const age = fate === 'fresh' ? 5 : 30 * 86_400;
          return { height: HEAD, timestamp: new Date(Date.now() - age * 1000).toISOString() };
        }
        if (w.head === 'fail') throw fail(spec.id, 'head');
        return { height: HEAD, ...(w.head === 'ok' ? { timestamp: NOW() } : {}) };
      },

      async finalizedHeight() {
        if (w.finalized === 'fail') throw fail(spec.id, 'finalized');
        return w.finalized === 'ok' ? HEAD - 64 : null;
      },

      async estimateFees() {
        log('estimateFees');
        if (!w.fees) throw fail(spec.id, 'fees');
        return { chain: spec.id, simpleTransfer: amount(21000n, 18, 'ETH'), details: { gasPrice: '1 gwei' } };
      },

      async readContract(_c: unknown, params: { atBlock?: number }) {
        log('readContract', params.atBlock);
        if (!w.contract) throw fail(spec.id, 'eth_call');
        return { result: '42', ...(params.atBlock === undefined ? {} : { atBlock: params.atBlock }) };
      },

      // The adapter's own payload is pinned by the EVM builder tests. What is
      // under test here is what reaches it: the address a name became.
      async buildTransfer(_c: unknown, params: { to: string; from?: string }) {
        log('buildTransfer');
        return {
          chain: spec.id,
          unsigned: true,
          family: spec.family,
          summary: `Send to ${params.to}.`,
          payload: { to: params.to, ...(params.from ? { from: params.from } : {}) },
          signingHint: 'Sign it in your wallet.',
          warnings: [],
        };
      },
    };

    if (w.history !== 'missing') {
      adapter.getHistory = async (_c: unknown, address: string) => {
        log('getHistory');
        const h = w.history as Exclude<ChainWorld['history'], 'missing'>;
        if (!h.ok) throw fail(spec.id, 'history');
        const entries = Array.from({ length: h.count }, (_, i) => ({ hash: `0x${i}`, status: 'success', direction: 'unknown', summary: 'Activity.' }));
        const c: Completeness =
          h.kind === 'truncated' ? completeness.paged(entries.length, 'A page.') : { kind: h.kind, note: `The fake says ${h.kind}.` };
        return { chain: spec.id, address, entries, completeness: c };
      };
    }

    return adapter;
  };

  return { adapterFor: fake, adapterForFamily: vi.fn() };
});

// Imported once at module scope; operations pulls in heavy dependencies.
const { getTool } = await import('../src/tools/catalog.js');
const { resetFinalityCache } = await import('../src/tools/operations.js');
const { getChain } = await import('../src/core/registry.js');

/** Every chain a 0x hash is searched on, plus a few for liveness. */
const EVM = ['ethereum', 'base', 'arbitrum', 'optimism', 'polygon', 'bsc'] as const;
const ADDRESSES = ['0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045', '0x000000000000000000000000000000000000dEaD'];
const HASH = `0x${'ab'.repeat(32)}`;

// ---- Worlds ---------------------------------------------------------------

const kind = fc.constantFrom<CompletenessKind>('exhaustive', 'curated', 'truncated', 'failed');

const chainWorld = (endpointCount: number): fc.Arbitrary<ChainWorld> =>
  fc.record({
    native: fc.oneof(fc.record({ ok: fc.constant(true as const), raw: fc.bigInt(0n, 10n ** 24n) }), fc.constant({ ok: false as const })),
    tokens: fc.oneof(
      fc.constant({ ok: false as const }),
      fc
        .record({ kind, count: fc.nat(4), omitted: fc.integer({ min: 1, max: 50 }), raws: fc.array(fc.bigInt(0n, 10n ** 12n), { minLength: 4, maxLength: 4 }) })
        .map((t) => ({ ok: true as const, ...t })),
    ),
    tx: fc.constantFrom<ChainWorld['tx']>('found', 'network', 'absent'),
    history: fc.oneof(
      fc.constant('missing' as const),
      fc.constant({ ok: false as const }),
      fc.record({ kind, count: fc.nat(5) }).map((h) => ({ ok: true as const, ...h })),
    ),
    head: fc.constantFrom<ChainWorld['head']>('ok', 'fail', 'undated'),
    finalized: fc.constantFrom<ChainWorld['finalized']>('ok', 'none', 'fail'),
    block: fc.boolean(),
    fees: fc.boolean(),
    pastReads: fc.array(fc.constantFrom<'ok' | 'pruned' | 'fail'>('ok', 'pruned', 'fail'), { minLength: 1, maxLength: 7 }),
    pastUnsupported: fc.boolean(),
    endpoints: fc.array(fc.constantFrom<ChainWorld['endpoints'][number]>('fresh', 'stale', 'undated', 'fail'), {
      minLength: endpointCount,
      maxLength: endpointCount,
    }),
    name: fc.constantFrom<ChainWorld['name']>('resolves', 'none', 'fail'),
    reverse: fc.constantFrom<ChainWorld['reverse']>('name', 'none', 'fail'),
    contract: fc.boolean(),
  });

const world = fc.record(Object.fromEntries(EVM.map((id) => [id, chainWorld(getChain(id).rpc.length)]))) as fc.Arbitrary<Record<string, ChainWorld>>;
const oneChain = fc.constantFrom(...EVM);

beforeEach(() => {
  state.calls = [];
  resetFinalityCache();
});

async function run(tool: string, w: Record<string, ChainWorld>, args: Record<string, unknown>) {
  state.world = w;
  state.calls = [];
  resetFinalityCache();
  const definition = getTool(tool);
  if (!definition) throw new Error(`No tool ${tool}`);
  try {
    return { ok: true as const, value: await definition.run(args) };
  } catch (error) {
    return { ok: false as const, error: error as Error & { code?: string } };
  }
}

function hold(violations: Violation[], context: unknown): void {
  if (violations.length) {
    throw new Error(`Invariant violated:\n${violations.map((v) => `  [${v.invariant}] ${v.path}: ${v.detail}`).join('\n')}\nin ${JSON.stringify(context, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v))}`);
  }
}

const RUNS = { numRuns: 150 };

// ---- Properties -----------------------------------------------------------

describe('every adapter-routed tool, against adapters that fail', () => {
  it('balance: a failed native read is an error, a failed scan says so, and no caveat gets stronger', async () => {
    await fc.assert(
      fc.asyncProperty(world, oneChain, async (w, chain) => {
        const result = await run('balance', w, { address: ADDRESSES[0], chain });
        const cw = w[chain]!;

        if (!cw.native.ok) {
          // A balance nobody read must not come back as a number.
          expect(result.ok).toBe(false);
          return;
        }
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const out = result.value as { native: { amount: { raw: string } }; tokens: unknown[]; tokenCompleteness: Completeness };

        const violations = [...checkShape(out)];
        expect(out.native.amount.raw).toBe(String(cw.native.raw));

        if (!cw.tokens.ok) {
          violations.push(...checkFailedRead(true, out.tokens, out.tokenCompleteness, '$.tokenCompleteness'));
          expect(out.tokens).toEqual([]);
        } else {
          const source: Completeness = cw.tokens.kind === 'truncated' ? { kind: 'truncated', note: 'x' } : { kind: cw.tokens.kind, note: 'x' };
          violations.push(...checkNotStronger([source], out.tokenCompleteness, '$.tokenCompleteness'));
          if (cw.tokens.kind === 'truncated') {
            violations.push(...checkCut(cw.tokens.count + cw.tokens.omitted, out.tokens.length, out.tokenCompleteness, '$.tokenCompleteness'));
          }
        }
        hold(violations, { chain, world: cw, out });
      }),
      RUNS,
    );
  });

  it('portfolio: every chain asked is either a balance or an error, and the whole is no stronger than its weakest part', async () => {
    const chains = fc.subarray([...EVM], { minLength: 1 });
    const addresses = fc.subarray(ADDRESSES, { minLength: 1 });

    await fc.assert(
      fc.asyncProperty(world, chains, addresses, async (w, requested, given) => {
        const result = await run('portfolio', w, { addresses: given, chains: requested });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const out = result.value as {
          chainsQueried: string[];
          balances: Array<{ chain: string; address: string; tokenCompleteness: Completeness }>;
          errors: Array<{ chain: string; address?: string }>;
          completeness: Completeness;
        };

        const violations = [...checkShape(out)];

        for (const address of given) {
          for (const chain of requested) {
            const asBalance = out.balances.filter((b) => b.chain === chain && b.address === address).length;
            const asError = out.errors.filter((e) => e.chain === chain && e.address === address).length;
            if (asBalance + asError !== 1) {
              violations.push({ invariant: 'searched-means-answered', path: '$', detail: `${chain} for ${address} appears ${asBalance} time(s) as a balance and ${asError} as an error.` });
            }
            if (asBalance && !w[chain]!.native.ok) {
              violations.push({ invariant: 'searched-means-answered', path: '$.balances', detail: `${chain} is reported with a balance and its read failed.` });
            }
          }
        }

        const parts = [
          ...out.balances.map((b) => b.tokenCompleteness),
          ...out.errors.map((): Completeness => ({ kind: 'failed', note: 'x' })),
        ];
        violations.push(...checkNotStronger(parts, out.completeness, '$.completeness'));
        hold(violations, { requested, given, out });
      }),
      RUNS,
    );
  });

  it('transaction: searched means answered, a failed chain is reported, and "not found" names only chains that answered', async () => {
    await fc.assert(
      fc.asyncProperty(world, async (w) => {
        const result = await run('transaction', w, { hash: HASH });

        const asked = [...new Set(state.calls.filter((c) => c.method === 'getTransaction').map((c) => c.chain))];
        const record: SearchRecord = {
          answered: asked.filter((id) => w[id]!.tx !== 'network'),
          failed: asked.filter((id) => w[id]!.tx === 'network'),
        };
        const holders = asked.filter((id) => w[id]!.tx === 'found');

        if (result.ok) {
          const out = result.value as { found: Array<{ chain: string }>; searched: string[]; unreachable?: Array<{ chain: string }> };
          expect(out.found.map((t) => t.chain).sort()).toEqual([...holders].sort());
          hold([...checkShape(out), ...checkSearched(record, out)], { record, out });
          return;
        }

        // A finality lookup that fails must never cost a transaction that was found.
        expect(holders, `found on ${holders.join(', ')} and still rejected: ${result.error.message}`).toEqual([]);

        if (result.error.code === 'TX_NOT_FOUND') {
          hold(checkNotFoundClaim(record, result.error.message), { record, message: result.error.message });
        } else {
          expect(result.error.code).toBe('TX_SEARCH_UNAVAILABLE');
          expect(record.answered).toEqual([]);
        }
      }),
      RUNS,
    );
  });

  it('history: a failed or missing read is never an empty list with a clean caveat', async () => {
    await fc.assert(
      fc.asyncProperty(world, oneChain, async (w, chain) => {
        const result = await run('history', w, { address: ADDRESSES[0], chain });
        const h = w[chain]!.history;

        if (!result.ok) {
          // Throwing is an honest way to fail; only a failed read may do it.
          expect(h !== 'missing' && !h.ok).toBe(true);
          return;
        }
        const out = result.value as { entries: unknown[]; completeness: Completeness };
        const violations = [...checkShape(out)];

        if (h === 'missing' || !h.ok) {
          violations.push(...checkFailedRead(true, out.entries, out.completeness, '$.completeness'));
        } else {
          violations.push(...checkNotStronger([{ kind: h.kind, note: 'x' }], out.completeness, '$.completeness'));
          expect(out.entries).toHaveLength(h.count);
        }
        hold(violations, { chain, history: h, out });
      }),
      RUNS,
    );
  });

  it('balance_series: a point is read only where the read answered, and the series is never complete', async () => {
    await fc.assert(
      fc.asyncProperty(world, oneChain, fc.integer({ min: 2, max: 12 }), async (w, chain, points) => {
        const result = await run('balance_series', w, { address: ADDRESSES[0], chain, from: -50_000, points });
        const cw = w[chain]!;

        if (!result.ok) {
          // Only a chain with no head, or one that cannot read the past at all, refuses the series.
          expect(cw.head === 'fail' || cw.pastUnsupported, result.error.message).toBe(true);
          return;
        }
        expect(cw.pastUnsupported).toBe(false);
        const out = result.value as {
          points: Array<{ block: number; status: string; amount?: { raw: string } }>;
          completeness: Completeness;
        };
        const violations = [...checkShape(out)];

        for (const [i, point] of out.points.entries()) {
          const fate = cw.pastReads[point.block % cw.pastReads.length]!;
          const expected = fate === 'ok' ? 'read' : fate === 'pruned' ? 'unavailable' : 'failed';
          if (point.status !== expected) {
            violations.push({ invariant: 'failure-is-not-empty', path: `$.points[${i}]`, detail: `Block ${point.block} was ${fate} and is reported ${point.status}.` });
          }
          if ((point.amount !== undefined) !== (point.status === 'read')) {
            violations.push({ invariant: 'failure-is-not-empty', path: `$.points[${i}]`, detail: `A ${point.status} point ${point.amount ? 'carries' : 'lacks'} an amount.` });
          }
        }

        const read = out.points.filter((p) => p.status === 'read').length;
        if (out.completeness.kind === 'exhaustive') {
          violations.push({ invariant: 'absence-needs-completeness', path: '$.completeness', detail: 'A series of readings called exhaustive.' });
        }
        if (read === 0) violations.push(...checkFailedRead(true, [], out.completeness, '$.completeness'));
        else violations.push(...checkCut(out.points.length, read, out.completeness, '$.completeness'));
        hold(violations, { chain, pastReads: cw.pastReads, out });
      }),
      RUNS,
    );
  });

  it('block and fees: a failed read is an error, never a value, and finality never costs the block', async () => {
    await fc.assert(
      fc.asyncProperty(world, oneChain, async (w, chain) => {
        const cw = w[chain]!;

        const block = await run('block', w, { chain, ref: HEAD - 5 });
        expect(block.ok).toBe(cw.block);
        if (block.ok) hold(checkShape(block.value), { block: block.value });

        const fees = await run('fees', w, { chain });
        expect(fees.ok).toBe(cw.fees);
        if (fees.ok) hold(checkShape(fees.value), { fees: fees.value });
      }),
      RUNS,
    );
  });

  it('chain_liveness: down exactly when nothing answered, and live never on fewer than two', async () => {
    await fc.assert(
      fc.asyncProperty(world, fc.subarray([...EVM], { minLength: 1, maxLength: 3 }), async (w, chains) => {
        const result = await run('chain_liveness', w, { chain: chains });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const reports = result.value as Array<{ chain: string; status: string; answering: number; configured: number }>;

        for (const report of reports) {
          const fates = w[report.chain]!.endpoints;
          const answered = fates.filter((f) => f !== 'fail').length;
          expect(report.answering, report.chain).toBe(answered);
          expect(report.status === 'down', `${report.chain} ${report.status} with ${answered} answering`).toBe(answered === 0);
          if (report.status === 'live') expect(answered).toBeGreaterThanOrEqual(2);
          if (report.status === 'live' || report.status === 'single') {
            // A head with no date, or one a month old, is not evidence of a live chain.
            expect(fates.some((f) => f === 'fresh'), `${report.chain} ${report.status} on ${fates.join(',')}`).toBe(true);
          }
        }
        hold(checkShape(reports), { reports });
      }),
      RUNS,
    );
  });

  it('resolve: a failed name lookup is an error, never "did not resolve", and a failed reverse lookup costs nothing', async () => {
    await fc.assert(
      fc.asyncProperty(world, oneChain, fc.boolean(), async (w, chain, byName) => {
        const cw = w[chain]!;
        const result = await run('resolve', w, { input: byName ? 'vitalik.eth' : ADDRESSES[0], chain });

        if (!byName) {
          // The address is the answer; a name for it is a nicety.
          expect(result.ok, cw.reverse).toBe(true);
          if (!result.ok) return;
          const out = result.value as { address?: string; name?: string };
          expect(out.address).toBe(ADDRESSES[0]);
          expect(out.name).toBe(cw.reverse === 'name' ? 'fake.eth' : undefined);
          hold(checkShape(out), { out });
          return;
        }

        if (cw.name === 'fail') {
          expect(result.ok, 'A failed name lookup came back as an answer.').toBe(false);
          return;
        }
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const out = result.value as { address?: string; note: string };
        expect(out.address).toBe(cw.name === 'resolves' ? NAMED : undefined);
        expect(/did not resolve/.test(out.note)).toBe(cw.name === 'none');
        hold(checkShape(out), { out });
      }),
      RUNS,
    );
  });

  it('read_contract: a failed call is an error, and "as of" is passed down exactly or not at all', async () => {
    const atBlock = fc.option(fc.oneof(fc.integer({ min: 1, max: HEAD }), fc.constant('latest' as const)), { nil: undefined });

    await fc.assert(
      fc.asyncProperty(world, oneChain, atBlock, async (w, chain, at) => {
        const result = await run('read_contract', w, {
          chain,
          address: ADDRESSES[0],
          method: 'totalSupply',
          abi: 'function totalSupply() view returns (uint256)',
          ...(at === undefined ? {} : { atBlock: at }),
        });
        const asked = state.calls.filter((c) => c.method === 'readContract');
        expect(asked).toHaveLength(1);
        // "latest" is current state; anything else must reach the adapter as that height.
        expect(asked[0]!.block).toBe(typeof at === 'number' ? at : undefined);

        expect(result.ok).toBe(w[chain]!.contract);
        if (result.ok) {
          expect((result.value as { atBlock?: number }).atBlock).toBe(typeof at === 'number' ? at : undefined);
          hold(checkShape(result.value), { out: result.value });
        }
      }),
      RUNS,
    );
  });

  it('build_transfer: a payload goes only to an address something answered with, and states it is unsigned', async () => {
    await fc.assert(
      fc.asyncProperty(world, oneChain, fc.boolean(), async (w, chain, byName) => {
        const cw = w[chain]!;
        const result = await run('build_transfer', w, { chain, to: byName ? 'vitalik.eth' : ADDRESSES[1], amount: '1' });

        if (byName && cw.name !== 'resolves') {
          expect(result.ok, `Built a transfer to a name whose lookup was ${cw.name}.`).toBe(false);
          if (!result.ok) {
            // "Did not resolve" is a claim about the name, and needs a lookup that answered.
            expect(result.error.code === 'NAME_NOT_RESOLVED', `${result.error.code} on a lookup that was ${cw.name}`).toBe(cw.name === 'none');
          }
          expect(state.calls.some((c) => c.method === 'buildTransfer')).toBe(false);
          return;
        }
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const out = result.value as { payload: { to: string } };
        expect(out.payload.to).toBe(byName ? NAMED : ADDRESSES[1]);
        hold(checkShape(out), { out });
      }),
      RUNS,
    );
  });

  it('mesh: answered only when every fact was proved, never from a read that failed, and no stronger than its steps', async () => {
    type Step = { tool: string; proved: string[]; completeness?: Completeness; error?: unknown };
    type MeshOut = {
      verdict: string;
      chain?: string;
      path: Step[];
      discarded: Step[];
      facts: Record<string, { value: unknown; source: string }>;
      unproven: Array<{ fact: string; why: string }>;
      completeness: Completeness;
    };
    const question = fc.oneof(
      fc.record({ subject: fc.constant(ADDRESSES[0]!), objective: fc.constantFrom('identify', 'holdings', 'activity') }),
      fc.record({ subject: fc.constant(HASH), objective: fc.constant('settlement') }),
      fc.record({ subject: oneChain as fc.Arbitrary<string>, objective: fc.constant('liveness') }),
    );

    await fc.assert(
      fc.asyncProperty(world, question, fc.option(oneChain, { nil: undefined }), async (w, q, hint) => {
        const chainArg = q.objective === 'liveness' ? q.subject : hint;
        const result = await run('mesh', w, { ...q, ...(chainArg ? { chain: chainArg } : {}), maxCalls: 16 });
        expect(result.ok, result.ok ? '' : result.error.message).toBe(true);
        if (!result.ok) return;
        const out = result.value as MeshOut;
        const steps = [...out.path, ...out.discarded];
        const violations = [...checkShape(out)];

        if ((out.verdict === 'answered') !== (out.unproven.length === 0)) {
          violations.push({ invariant: 'absence-needs-completeness', path: '$.verdict', detail: `${out.verdict} with ${out.unproven.length} unproven.` });
        }
        if (out.verdict === 'answered' && out.completeness.kind === 'failed') {
          violations.push({ invariant: 'absence-needs-completeness', path: '$.completeness', detail: 'Answered, over a read that failed.' });
        }
        violations.push(...checkNotStronger(steps.flatMap((s) => (s.completeness ? [s.completeness] : [])), out.completeness, '$.completeness'));

        // Each fact, against the world it was read from.
        const cw = out.chain ? w[out.chain] : undefined;
        if (cw && 'tokens' in out.facts && !cw.tokens.ok) {
          violations.push({ invariant: 'failure-is-not-empty', path: '$.facts.tokens', detail: `Token holdings on ${out.chain} proved by a scan that failed.` });
        }
        if (cw && 'activity' in out.facts && (cw.history === 'missing' || !cw.history.ok)) {
          violations.push({ invariant: 'failure-is-not-empty', path: '$.facts.activity', detail: `Activity on ${out.chain} proved by a history read that ${cw.history === 'missing' ? 'does not exist' : 'failed'}.` });
        }
        if (cw && 'nativeBalance' in out.facts && !cw.native.ok) {
          violations.push({ invariant: 'failure-is-not-empty', path: '$.facts.nativeBalance', detail: `A native balance on ${out.chain} that nobody read.` });
        }
        if (cw && 'fees' in out.facts && !cw.fees) {
          violations.push({ invariant: 'failure-is-not-empty', path: '$.facts.fees', detail: `Fees on ${out.chain} that nobody read.` });
        }
        if ('txSummary' in out.facts) {
          const chain = (out.facts.txSummary.value as { chain?: string }).chain;
          if (!chain || w[chain]?.tx !== 'found') {
            violations.push({ invariant: 'searched-means-answered', path: '$.facts.txSummary', detail: `A transaction summarized from ${chain}, which never returned it.` });
          }
        }
        for (const step of steps) {
          if (step.error && step.proved.length) {
            violations.push({ invariant: 'failure-is-not-empty', path: '$.path', detail: `${step.tool} errored and proved ${step.proved.join(', ')}.` });
          }
        }
        hold(violations, { q, hint, out: { verdict: out.verdict, facts: out.facts, unproven: out.unproven, completeness: out.completeness } });
      }),
      { numRuns: 100 },
    );
  });
});
