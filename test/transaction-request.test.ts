import { describe, it, expect, afterEach } from 'vitest';
import {
  allowedMints,
  burnLink,
  describeBurnRequest,
  parseBurnRequest,
} from '../src/pay/transaction-request.js';

/**
 * A burn somebody can approve in their wallet.
 *
 * The signing seam does not move — this tool holds no keys — but handing a
 * person base64 in a chat message and asking them to own the signing step is
 * the worst available way to reach the wallet where the keys already are. A
 * transaction request moves the work there: the bot posts a link, the wallet
 * fetches it and posts back the account that will sign, and the user approves a
 * burn they can read.
 *
 * The parts worth testing are the parts a wallet cannot check for you: which
 * mints a link may name, and whether the link survives carrying its own query
 * string.
 */
const SNGLRTY = '5pTy48gtfzaR8NPUVZTbybVUGpQvFT4JsNHzwQE8pump';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const ENDPOINT = 'https://singularity-agent-nine.vercel.app/api/burn';

afterEach(() => {
  delete process.env.SINGULARITY_BURN_MINTS;
});

describe('which mints a link may name', () => {
  it('serves the project mint by default', () => {
    expect(allowedMints()).toEqual([SNGLRTY]);
    expect(parseBurnRequest({ mint: SNGLRTY, amount: '1000' }).mint).toBe(SNGLRTY);
  });

  it('refuses a mint nobody put on the list', () => {
    // A transaction request is a URL anyone can craft and send to anyone, and
    // the wallet shows its origin — so an endpoint that will build a burn of
    // anything is a phishing primitive wearing this project's domain, and it
    // works better the more that domain is trusted.
    expect(() => parseBurnRequest({ mint: USDC, amount: '1' })).toThrow(/does not build burns for/);
  });

  it('takes its list from configuration', () => {
    process.env.SINGULARITY_BURN_MINTS = `${SNGLRTY}, ${USDC}`;

    expect(allowedMints()).toEqual([SNGLRTY, USDC]);
    expect(parseBurnRequest({ mint: USDC, amount: '1' }).mint).toBe(USDC);
  });
});

describe('what a link has to carry', () => {
  it('needs both the mint and the amount', () => {
    // The two things a wallet cannot supply: it knows the account, and nothing
    // else about the intent.
    expect(() => parseBurnRequest({ amount: '1' })).toThrow(/needs both/);
    expect(() => parseBurnRequest({ mint: SNGLRTY })).toThrow(/needs both/);
  });

  it('refuses an amount that is not one', () => {
    expect(() => parseBurnRequest({ mint: SNGLRTY, amount: 'all' })).toThrow(/is not an amount/);
    expect(() => parseBurnRequest({ mint: SNGLRTY, amount: '1e9' })).toThrow(/is not an amount/);
    // Whole tokens as a decimal string, which is the rule everywhere else here.
    expect(parseBurnRequest({ mint: SNGLRTY, amount: '0.5' }).amount).toBe('0.5');
  });

  it('caps the memo rather than refusing a long one', () => {
    const params = parseBurnRequest({ mint: SNGLRTY, amount: '1', memo: 'x'.repeat(400) });
    expect(params.memo).toHaveLength(256);
  });

  it('survives the inner url having its own query string', () => {
    const link = burnLink(ENDPOINT, { mint: SNGLRTY, amount: '1000', memo: 'sngl:-100431' });

    // Encoded whole. A wallet splitting the solana: URI on the first `?` would
    // otherwise drop every parameter after it, and the request would arrive
    // naming no mint at all.
    expect(link.startsWith('solana:')).toBe(true);
    expect(link).not.toMatch(/\?mint=/);

    const inner = new URL(decodeURIComponent(link.slice('solana:'.length)));
    expect(inner.searchParams.get('mint')).toBe(SNGLRTY);
    expect(inner.searchParams.get('amount')).toBe('1000');
    expect(inner.searchParams.get('memo')).toBe('sngl:-100431');
  });

  it('tells the wallet what to show before anyone approves anything', () => {
    const shown = describeBurnRequest({ mint: SNGLRTY, amount: '1000' });

    expect(shown.label).toBe('Burn 1000');
    expect(shown.icon).toMatch(/^https:/);
  });
});
