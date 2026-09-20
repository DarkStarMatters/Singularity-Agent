import { describe, it, expect } from 'vitest';
import {
  METAPLEX_URI_LIMIT,
  receiptFacts,
  receiptImage,
  receiptMetadata,
  receiptName,
  uriFits,
  verifyReceiptImage,
} from '../src/art/receipt.js';
import type { StoredIntent } from '../src/pay/intent.js';
import type { PaymentSettlement } from '../src/pay/types.js';

/**
 * A receipt is evidence, so the tests are mostly about refusing to issue one.
 *
 * The failure mode worth guarding is not a crash. It is a token that looks like
 * proof of payment and is not — minted against a confirmed-but-reversible
 * transaction, or against a payment that landed in the wrong mint. Those tokens
 * are permanent and the transactions behind them are not.
 */

const REFERENCE = '695xPtsSYaSALQdwgE6WxC4zX49zZrpVPwF2uiUGjCBB';
const RECIPIENT = 'BTaPkeDYRuXbL6hEDsWPAWXUfZvjEoKoV3mCTQ91QFeH';
const SIGNATURE = '5x7Kqf9Qw2vMhT3bN8pLzR4cY6dA1eF0gH2jK3mN4pQ5rS6tU7vW8xY9zA1bC2dE3f';

const intent: StoredIntent = {
  id: 'int_1',
  reference: REFERENCE,
  to: RECIPIENT,
  amount: '0.25',
  label: 'Singularity',
  chain: 'solana',
  createdAt: '2026-09-20T10:00:00.000Z',
  expiresAt: '2026-09-20T10:15:00.000Z',
};

const settled: PaymentSettlement = {
  level: 'final',
  signature: SIGNATURE,
  at: '2026-09-20T10:02:11.000Z',
  mismatches: [],
  note: 'Finalized and matching the claim.',
};

describe('what a receipt refuses to say', () => {
  it('will not attest to a payment that is only probabilistic', () => {
    // Confirmed is reversible. The token would not be.
    expect(() => receiptFacts(intent, { ...settled, level: 'probabilistic' })).toThrow(/final/i);
  });

  it('will not attest to an unpaid intent', () => {
    expect(() => receiptFacts(intent, { ...settled, level: 'unpaid' })).toThrow(/final/i);
  });

  it('will not attest to a payment that does not match the claim', () => {
    // Final, and not yours: the exact case a boolean rail would call paid.
    const wrongMint = { ...settled, mismatches: ['mint: expected USDC, got a lookalike'] };
    expect(() => receiptFacts(intent, wrongMint)).toThrow(/does not match/i);
  });

  it('will not attest without a signature to point at', () => {
    const { signature, ...unsigned } = settled;
    expect(() => receiptFacts(intent, unsigned as PaymentSettlement)).toThrow(/signature/i);
  });

  it('accepts a finalized, matching payment', () => {
    const facts = receiptFacts(intent, settled);
    expect(facts.signature).toBe(SIGNATURE);
    expect(facts.reference).toBe(REFERENCE);
    expect(facts.settledAt).toBe('2026-09-20T10:02:11.000Z');
  });

  it('takes the settled time from the chain rather than this machine', () => {
    // A receipt dated by the server clock is a receipt that disagrees with the
    // explorer a holder will check it against.
    expect(receiptFacts(intent, settled).settledAt).toBe(settled.at);
  });
});

describe('the image, which is the part that must be checkable', () => {
  const facts = receiptFacts(intent, settled);

  it('re-renders identically from the reference alone', () => {
    expect(receiptImage(facts)).toBe(receiptImage(facts));
  });

  it('verifies an image that matches the payment', () => {
    expect(verifyReceiptImage(facts, receiptImage(facts))).toBe(true);
  });

  it('rejects an image a host swapped for a different one', () => {
    // The whole reason the seed is on chain and the picture is not.
    const other = receiptImage({ ...facts, reference: 'A'.repeat(43) });
    expect(verifyReceiptImage(facts, other)).toBe(false);
  });

  it('rejects an image that was edited rather than replaced', () => {
    const tampered = receiptImage(facts).replace('</svg>', '<rect/></svg>');
    expect(verifyReceiptImage(facts, tampered)).toBe(false);
  });
});

describe('the metadata a marketplace reads', () => {
  const facts = receiptFacts(intent, settled);
  const meta = receiptMetadata(facts, { image: 'https://example.test/r.svg' });

  it('names the reference first, since everything else derives from it', () => {
    const attrs = meta['attributes'] as Array<{ trait_type: string; value: string }>;
    expect(attrs[0]).toEqual({ trait_type: 'Reference', value: REFERENCE });
  });

  it('carries the amount, token and recipient as traits', () => {
    const attrs = meta['attributes'] as Array<{ trait_type: string; value: string }>;
    const byTrait = Object.fromEntries(attrs.map((a) => [a.trait_type, a.value]));

    expect(byTrait['Amount']).toBe('0.25');
    expect(byTrait['Token']).toBe('SOL');
    expect(byTrait['Recipient']).toBe(RECIPIENT);
    expect(byTrait['Settlement']).toBe('final');
  });

  it('names the mint rather than a ticker when one is set', () => {
    // A symbol is not an identity anywhere else in this project either.
    const mint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    const withMint = receiptFacts({ ...intent, mint }, settled);
    const attrs = receiptMetadata(withMint, { image: 'x' })['attributes'] as Array<{
      trait_type: string;
      value: string;
    }>;

    expect(attrs.find((a) => a.trait_type === 'Token')?.value).toBe(mint);
  });

  it('links to the transaction so a holder can check it themselves', () => {
    expect(meta['external_url']).toContain(SIGNATURE);
  });

  it('keeps the symbol inside the ten-character on-chain limit', () => {
    const long = receiptMetadata(facts, { image: 'x', symbol: 'WAYTOOLONGSYMBOL' });
    expect((long['symbol'] as string).length).toBeLessThanOrEqual(10);
  });

  it('includes the order id only when there is one', () => {
    const attrs = meta['attributes'] as Array<{ trait_type: string }>;
    expect(attrs.some((a) => a.trait_type === 'Order')).toBe(false);

    const ordered = receiptFacts({ ...intent, orderId: 'ord-7' }, settled);
    const withOrder = receiptMetadata(ordered, { image: 'x' })['attributes'] as Array<{
      trait_type: string;
      value: string;
    }>;
    expect(withOrder.find((a) => a.trait_type === 'Order')?.value).toBe('ord-7');
  });
});

describe('the on-chain limits, which are the reason for this design', () => {
  const facts = receiptFacts(intent, settled);

  it('keeps the name within the 32-byte Metaplex field', () => {
    expect(receiptName(facts).length).toBeLessThanOrEqual(32);
  });

  it('confirms a data URI cannot fit, which is why the seed goes on chain instead', () => {
    // Not a hypothetical: this is the measurement the module is built around.
    // The smallest receipt SVG is ~30KB, so a data URI misses the 200-byte uri
    // field by two orders of magnitude.
    const dataUri = `data:image/svg+xml;base64,${Buffer.from(receiptImage(facts)).toString('base64')}`;

    expect(uriFits(dataUri)).toBe(false);
    expect(dataUri.length).toBeGreaterThan(METAPLEX_URI_LIMIT * 100);
  });

  it('accepts an ordinary hosted uri', () => {
    expect(uriFits('https://example.test/receipts/695xPtsS.json')).toBe(true);
  });

  it('measures bytes rather than characters', () => {
    // A multi-byte path would otherwise pass the check and fail the mint.
    expect(uriFits('https://x.test/'.concat('é'.repeat(200)))).toBe(false);
  });
});
