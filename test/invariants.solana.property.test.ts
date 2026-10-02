import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import fc from 'fast-check';
import { checkShape } from '../src/core/invariants.js';

/**
 * The Solana payment and trade tools, against a chain that never gives evidence.
 *
 * These tools do not go through the adapter registry the other property suite
 * fakes. They take a web3.js `Connection` of their own, so the fake here sits at
 * the connection. Each RPC method either fails or answers with the chain's own
 * empty answer: no account, no transaction, no holders, no signatures.
 *
 * Under that, one property holds for every tool: **nothing it says is a green
 * light.** No `payable`, no `proven`, no `canExit: true`, no matched burn, and
 * no unsigned payload built for a mint nobody could read. That is violation
 * five's class: a check that stopped running and a demand that came back
 * `payable` anyway. Here every check runs against no evidence, and whichever
 * path a tool takes, it must end in "not established" or in an error.
 *
 * No world here produces real account bytes, so this cannot show a correct
 * positive verdict is reached. The payment and burn suites pin those against
 * recorded mainnet transactions. This holds the other direction, which is the
 * one that costs money.
 */

type Fate = 'fail' | 'empty';

const METHODS = [
  'getAccountInfo',
  'getBalance',
  'getBlockSignatures',
  'getBlockTime',
  'getLatestBlockhash',
  'getMultipleAccountsInfo',
  'getParsedAccountInfo',
  'getParsedTokenAccountsByOwner',
  'getParsedTransaction',
  'getRecentPrioritizationFees',
  'getSignaturesForAddress',
  'getSignatureStatuses',
  'getSlot',
  'getTokenLargestAccounts',
  'getTokenSupply',
  'simulateTransaction',
] as const;

type Method = (typeof METHODS)[number];

const state = vi.hoisted(() => ({
  fates: {} as Record<string, 'fail' | 'empty'>,
  /** When set, the first endpoint fails every call, so failover is exercised. */
  firstEndpointDown: false,
  endpoints: [] as string[],
  unexpected: [] as string[],
}));

vi.mock('@solana/web3.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@solana/web3.js')>();
  const context = { slot: 1_000 };

  const empty: Record<string, (...args: unknown[]) => unknown> = {
    getAccountInfo: () => null,
    getBalance: () => 0,
    getBlockSignatures: () => {
      throw new Error('Block not available for slot');
    },
    getBlockTime: () => null,
    getLatestBlockhash: () => ({ blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 100 }),
    getMultipleAccountsInfo: (keys: unknown) => (keys as unknown[]).map(() => null),
    getParsedAccountInfo: () => ({ context, value: null }),
    getParsedTokenAccountsByOwner: () => ({ context, value: [] }),
    getParsedTransaction: () => null,
    getRecentPrioritizationFees: () => [],
    getSignaturesForAddress: () => [],
    getSignatureStatuses: (signatures: unknown) => ({ context, value: (signatures as unknown[]).map(() => null) }),
    getSlot: () => 1_000,
    getTokenLargestAccounts: () => ({ context, value: [] }),
    getTokenSupply: () => ({ context, value: { amount: '0', decimals: 0, uiAmount: 0, uiAmountString: '0' } }),
    // An account that does not exist cannot be debited; that is the empty answer.
    simulateTransaction: () => ({ context, value: { err: 'AccountNotFound', logs: [], accounts: null, unitsConsumed: 0 } }),
  };

  class FakeConnection {
    constructor(readonly endpoint: string) {
      if (!state.endpoints.includes(endpoint)) state.endpoints.push(endpoint);
      return new Proxy(this, {
        get(target, prop, receiver) {
          if (typeof prop !== 'string' || prop in target) return Reflect.get(target, prop, receiver);
          return async (...args: unknown[]) => {
            if (!(prop in empty)) {
              state.unexpected.push(prop);
              throw new Error(`The fake connection does not answer ${prop}.`);
            }
            if (state.firstEndpointDown && state.endpoints.indexOf(endpoint) === 0) throw new Error(`${prop}: fetch failed`);
            if (state.fates[prop] === 'fail') throw new Error(`${prop}: 503 Service Unavailable`);
            return empty[prop]!(...args);
          };
        },
      });
    }
  }

  return { ...actual, Connection: FakeConnection };
});

const realFetch = globalThis.fetch;
beforeAll(() => {
  // Metadata and identity documents are off-chain; here they are unreachable too.
  globalThis.fetch = (async () => {
    throw new Error('network disabled in this test');
  }) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

const { getTool } = await import('../src/tools/catalog.js');

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const WALLET = 'BTaPkeDYRuXbL6hEDsWPAWXUfZvjEoKoV3mCTQ91QFeH';
const PAYER = 'Bu7qJvHhgnBcRDbrESKSnXBPNs5QNLhFBStHXVxk8AZS';
const SIGNATURE = '5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW';

const world = fc.record({
  fates: fc.record(Object.fromEntries(METHODS.map((m) => [m, fc.constantFrom<Fate>('fail', 'empty')])) as Record<Method, fc.Arbitrary<Fate>>),
  firstEndpointDown: fc.boolean(),
});

async function run(tool: string, w: { fates: Record<string, Fate>; firstEndpointDown: boolean }, args: Record<string, unknown>) {
  state.fates = w.fates;
  state.firstEndpointDown = w.firstEndpointDown;
  try {
    return { ok: true as const, value: (await getTool(tool)!.run(args)) as Record<string, unknown> };
  } catch (error) {
    return { ok: false as const, error: error as Error };
  }
}

function noGreenLight(result: Awaited<ReturnType<typeof run>>, check: (value: Record<string, unknown>) => string | null) {
  if (!result.ok) return;
  const violations = checkShape(result.value);
  expect(violations, JSON.stringify(violations)).toEqual([]);
  const problem = check(result.value);
  expect(problem, `${problem}\n${JSON.stringify(result.value, null, 1).slice(0, 1500)}`).toBeNull();
}

const RUNS = { numRuns: 60 };
const amount = fc.constantFrom('1', '0.5', '25', '1000000');
const memo = fc.option(fc.constantFrom('order-17', 'inv 2026-10'), { nil: undefined });

describe('the Solana payment and trade tools, with no evidence on chain', () => {
  it('inspect_payment never calls a demand payable', async () => {
    await fc.assert(
      fc.asyncProperty(world, amount, memo, fc.option(fc.constantFrom(6, 9), { nil: undefined }), async (w, amt, m, decimals) => {
        const result = await run('inspect_payment', w, { to: WALLET, mint: USDC, asset: 'USDC', amount: amt, ...(m ? { memo: m } : {}), ...(decimals ? { decimals } : {}) });
        noGreenLight(result, (r) => (r.verdict === 'payable' ? 'A demand on a mint nobody could read came back payable.' : null));
      }),
      RUNS,
    );
  });

  it('build_payment builds nothing', async () => {
    await fc.assert(
      fc.asyncProperty(world, amount, memo, async (w, amt, m) => {
        const result = await run('build_payment', w, { from: PAYER, to: WALLET, mint: USDC, asset: 'USDC', amount: amt, ...(m ? { memo: m } : {}) });
        noGreenLight(result, (r) => ('transaction' in r && r.transaction ? 'Built a payment the demand check could not establish.' : null));
      }),
      RUNS,
    );
  });

  it('prove_payment never calls a payment proven', async () => {
    await fc.assert(
      fc.asyncProperty(world, amount, memo, async (w, amt, m) => {
        const result = await run('prove_payment', w, { signature: SIGNATURE, to: WALLET, mint: USDC, amount: amt, ...(m ? { memo: m } : {}) });
        noGreenLight(result, (r) => (r.verdict === 'proven' ? 'Proved a payment from a transaction nobody read.' : null));
      }),
      RUNS,
    );
  });

  it('verify_burn never matches a burn', async () => {
    await fc.assert(
      fc.asyncProperty(world, async (w) => {
        const result = await run('verify_burn', w, { signature: SIGNATURE, mint: USDC, owner: WALLET });
        noGreenLight(result, (r) => {
          if (r.matched) return 'Matched a burn in a transaction nobody read.';
          const burns = (r.receipt as { burns?: unknown[] } | undefined)?.burns ?? [];
          return burns.length ? 'Reported burns from no transaction.' : null;
        });
      }),
      RUNS,
    );
  });

  it('inspect_exit never says the way out is open', async () => {
    await fc.assert(
      fc.asyncProperty(world, async (w) => {
        const result = await run('inspect_exit', w, { mint: USDC });
        noGreenLight(result, (r) => (r.canExit === true ? 'canExit: true for a mint account nobody read.' : null));
      }),
      RUNS,
    );
  });

  it('mint_audit never reports a mint with nothing possible', async () => {
    await fc.assert(
      fc.asyncProperty(world, async (w) => {
        const result = await run('mint_audit', w, { mint: USDC });
        // An empty `powers` list reads as "nothing can happen to you".
        noGreenLight(result, (r) => (Array.isArray(r.powers) ? 'Audited a mint account nobody read.' : null));
      }),
      RUNS,
    );
  });

  it('build_burn builds nothing for a mint nobody could read', async () => {
    await fc.assert(
      fc.asyncProperty(world, amount, async (w, amt) => {
        const result = await run('build_burn', w, { mint: USDC, amount: amt, owner: WALLET });
        noGreenLight(result, (r) => ('payload' in r ? 'Built a burn without reading the mint.' : null));
      }),
      RUNS,
    );
  });

  // Not a green light in the other direction: a failed read stated as an
  // absence. This one was live when the suite was written. With every endpoint
  // down, inspect_payment said "No SPL mint exists" at USDC's address.
  it('says a mint does not exist only when the read of it answered', async () => {
    await fc.assert(
      fc.asyncProperty(world, amount, async (w, amt) => {
        const demand = { to: WALLET, mint: USDC, asset: 'USDC', amount: amt };
        const readFailed = w.fates.getAccountInfo === 'fail';

        const inspected = await run('inspect_payment', w, demand);
        expect(inspected.ok).toBe(true);
        if (!inspected.ok) return;
        const codes = (inspected.value.findings as Array<{ code: string }>).map((f) => f.code);
        if (readFailed) {
          expect(codes, 'a failed read reported as a missing mint').not.toContain('TOKEN_DOES_NOT_EXIST');
          expect(inspected.value.verdict).toBe('unproven');
        } else {
          expect(codes).toContain('TOKEN_DOES_NOT_EXIST');
        }

        const built = await run('build_payment', w, { ...demand, from: PAYER });
        expect(built.ok).toBe(false);
        if (!built.ok && readFailed) expect(built.error.message).not.toMatch(/No SPL mint exists/);
      }),
      RUNS,
    );
  });

  it('says a burn was not found only when both lookups answered', async () => {
    await fc.assert(
      fc.asyncProperty(world, async (w) => {
        const result = await run('verify_burn', w, { signature: SIGNATURE });
        expect(result.ok).toBe(false);
        if (result.ok) return;
        const answered = w.fates.getParsedTransaction === 'empty' && w.fates.getSignatureStatuses === 'empty';
        const code = (result.error as { code?: string }).code;
        expect(code === 'TX_NOT_FOUND', `${code} with transaction ${w.fates.getParsedTransaction}, status ${w.fates.getSignatureStatuses}`).toBe(answered);
      }),
      RUNS,
    );
  });

  // The three tools left on Solana. Each reads an account that is either
  // unreadable or absent here, so each may answer "it is not there" only when
  // the read of it answered, and only build_transfer of native SOL, which
  // needs nothing but a blockhash, may build at all.
  const ABSENCE = /NOT_A_MINT|NOT_FOUND|DOES_NOT_EXIST/;

  it('build_transfer builds native SOL exactly when a blockhash was read, and a token transfer never', async () => {
    await fc.assert(
      fc.asyncProperty(world, amount, fc.boolean(), async (w, amt, token) => {
        const result = await run('build_transfer', w, { chain: 'solana', from: PAYER, to: WALLET, amount: amt, ...(token ? { token: USDC } : {}) });
        if (token) {
          expect(result.ok, 'Built a token transfer without reading the mint.').toBe(false);
          if (!result.ok && w.fates.getAccountInfo === 'fail') expect((result.error as { code?: string }).code ?? '').not.toMatch(ABSENCE);
          return;
        }
        expect(result.ok).toBe(w.fates.getLatestBlockhash === 'empty');
        noGreenLight(result, () => null);
      }),
      RUNS,
    );
  });

  it('read_contract says an account does not exist only when the read of it answered', async () => {
    await fc.assert(
      fc.asyncProperty(world, async (w) => {
        const result = await run('read_contract', w, { chain: 'solana', address: WALLET });
        expect(result.ok).toBe(false);
        if (result.ok) return;
        const code = (result.error as { code?: string }).code ?? '';
        expect(ABSENCE.test(code), `${code} with getParsedAccountInfo ${w.fates.getParsedAccountInfo}`).toBe(w.fates.getParsedAccountInfo === 'empty');
      }),
      RUNS,
    );
  });

  it('token_identity never declares an identity for a mint nobody read', async () => {
    await fc.assert(
      fc.asyncProperty(world, fc.boolean(), async (w, fetchDocument) => {
        const result = await run('token_identity', w, { mint: USDC, fetch: fetchDocument });
        expect(result.ok, 'An identity from a mint account nobody read.').toBe(false);
        if (result.ok) return;
        const code = (result.error as { code?: string }).code ?? '';
        if (w.fates.getAccountInfo === 'fail') expect(code, 'a failed read reported as no mint').not.toMatch(ABSENCE);
      }),
      RUNS,
    );
  });

  it('asked the fake only for methods it knows', () => {
    // A tool calling a method this file never heard of would have failed for
    // that reason alone and passed every property above for the wrong one.
    expect([...new Set(state.unexpected)]).toEqual([]);
  });
});
