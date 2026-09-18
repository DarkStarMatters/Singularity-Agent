import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getChain } from '../src/core/registry.js';
import { cosmosAdapter, resetDenomCache } from '../src/adapters/cosmos.js';

/**
 * A Cosmos denom does not carry its scale, and guessing it is a trillion-fold
 * error that looks like a number.
 *
 * Every non-native denom used to be rendered at 6 decimals on the reasoning
 * that `u` means micro. It does, for most of them. It does not for the ones
 * that track an 18-decimal asset: `stinj` and `staevmos` are Stride's liquid
 * staking receipts for INJ and EVMOS. A real account holding 0.16 stEVMOS was
 * reported as holding 159,974,492,619 — while holding six microSTRD, which is
 * what made it obvious to a human and invisible to everything else.
 *
 * The fix is not a better guess. The chain either states a denom's decimals in
 * its bank metadata or it does not, and where it does not the only honest
 * answer is base units, said out loud. These hold both halves, and the exact
 * wrong number is asserted against by value so that a regression cannot pass
 * by being merely plausible.
 */

const STRIDE = getChain('stride');
const OWNER = 'stride1qycjurmk50w38fettjqfyar4pmuc9wfrx58emc';

/** The real figures from the account that exposed this. */
const STAEVMOS_RAW = '159974492619775658';
const WRONG_AT_SIX = '159974492619.775658';

interface Route {
  balances?: { denom: string; amount: string }[];
  metadata?: Record<string, { display: string; exponent: number }>;
}

let metadataCalls = 0;

function stubChain({ balances = [], metadata = {} }: Route): void {
  metadataCalls = 0;

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url.includes('/cosmos/bank/v1beta1/balances/')) {
        return new Response(JSON.stringify({ balances }), { status: 200 });
      }

      if (url.includes('/cosmos/bank/v1beta1/denoms_metadata/')) {
        metadataCalls += 1;
        const denom = decodeURIComponent(url.split('/denoms_metadata/')[1] ?? '');
        const entry = metadata[denom];

        // Stride answers 404 for a denom it publishes nothing about; that is
        // the case this exists for, so it is the shape mocked here.
        if (!entry) return new Response('not found', { status: 404 });

        return new Response(
          JSON.stringify({
            metadata: {
              display: entry.display,
              denom_units: [
                { denom, exponent: 0 },
                { denom: entry.display, exponent: entry.exponent },
              ],
            },
          }),
          { status: 200 },
        );
      }

      return new Response('{}', { status: 200 });
    }),
  );
}

beforeEach(() => resetDenomCache());
afterEach(() => vi.unstubAllGlobals());

describe('a denom the chain says nothing about', () => {
  it('reports base units instead of a number scaled by a guess', async () => {
    stubChain({ balances: [{ denom: 'staevmos', amount: STAEVMOS_RAW }] });

    const result = await cosmosAdapter.getTokenBalances(STRIDE, OWNER);
    const entry = result.entries[0];

    expect(entry?.amount.decimalsUnknown).toBe(true);
    expect(entry?.amount.raw).toBe(STAEVMOS_RAW);
    expect(entry?.amount.formatted).toBe(STAEVMOS_RAW);

    // The specific wrong answer, named so it cannot come back quietly.
    expect(entry?.amount.formatted).not.toBe(WRONG_AT_SIX);
  });

  it('does not claim a decimals value on the token either', async () => {
    stubChain({ balances: [{ denom: 'stinj', amount: '1288365375353257' }] });

    const entry = (await cosmosAdapter.getTokenBalances(STRIDE, OWNER)).entries[0];

    // Absent, not zero. A consumer that reads 0 and formats with it lands back
    // on a confident wrong number, which is the thing being removed.
    expect(entry?.token.decimals).toBeUndefined();
  });

  it('says so in the completeness note rather than in a comment', async () => {
    stubChain({ balances: [{ denom: 'stinj', amount: '1' }] });

    const note = (await cosmosAdapter.getTokenBalances(STRIDE, OWNER)).completeness.note;

    expect(note).toContain('base units');
    expect(note).not.toContain('assumed to be 6');
  });
});

describe('a denom the chain does describe', () => {
  it('uses the exponent it states, including 18', async () => {
    stubChain({
      balances: [{ denom: 'staevmos', amount: STAEVMOS_RAW }],
      metadata: { staevmos: { display: 'stevmos', exponent: 18 } },
    });

    const entry = (await cosmosAdapter.getTokenBalances(STRIDE, OWNER)).entries[0];

    expect(entry?.amount.decimalsUnknown).toBeUndefined();
    expect(entry?.token.decimals).toBe(18);

    // `formatted` is a display value trimmed to 8 fraction digits; `raw` is the
    // exact one. The point of the assertion is the magnitude: a fraction of one
    // stEVMOS rather than a hundred and sixty billion of them.
    expect(entry?.amount.formatted).toBe('0.15997449');
    expect(entry?.amount.raw).toBe(STAEVMOS_RAW);
  });

  it('still formats a six-decimal denom the ordinary way', async () => {
    stubChain({
      balances: [{ denom: 'stuatom', amount: '27284' }],
      metadata: { stuatom: { display: 'statom', exponent: 6 } },
    });

    const entry = (await cosmosAdapter.getTokenBalances(STRIDE, OWNER)).entries[0];

    expect(entry?.amount.formatted).toBe('0.027284');
    expect(entry?.token.decimals).toBe(6);
  });

  it('asks once per denom, including when the answer was nothing', async () => {
    stubChain({
      balances: [
        { denom: 'stinj', amount: '5' },
        { denom: 'stinj', amount: '5' },
      ],
    });

    await cosmosAdapter.getTokenBalances(STRIDE, OWNER);
    await cosmosAdapter.getTokenBalances(STRIDE, OWNER);

    expect(metadataCalls).toBe(1);
  });
});

describe('the native denom, which the chain spec already states', () => {
  it('is unaffected and costs no metadata lookup', async () => {
    stubChain({ balances: [{ denom: 'ustrd', amount: '6' }] });

    const native = await cosmosAdapter.getNativeBalance(STRIDE, OWNER);

    expect(native.amount.formatted).toBe('0.000006');
    expect(native.amount.decimalsUnknown).toBeUndefined();
    expect(metadataCalls).toBe(0);
  });
});

describe('building a transfer of a denom with no stated scale', () => {
  it('refuses rather than picking an exponent', async () => {
    stubChain({ balances: [] });

    await expect(
      cosmosAdapter.buildTransfer(STRIDE, {
        from: OWNER,
        to: OWNER,
        amount: '1.5',
        token: 'stinj',
      }),
    ).rejects.toThrow(/decimals/i);
  });
});
