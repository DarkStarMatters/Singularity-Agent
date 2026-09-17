import { describe, it, expect } from 'vitest';
import { formatUnsignedTx } from '../src/telegram/format.js';
import { renderUnsignedTx } from '../src/cli/render.js';
import type { UnsignedTx } from '../src/core/types.js';

/**
 * A payload is a proposal; a signature is its receipt.
 *
 * They are both long opaque strings, they arrive minutes apart, and on Solana
 * the payload field is called `transaction` — which reads as "the transaction",
 * the thing an explorer would show you. Under a heading of "Payload" that was
 * enough for somebody to paste it into `/redeem` and be told, accurately and
 * uselessly, that it was not a signature.
 *
 * The bytes were never wrong. The labelling was, and this is what holds the
 * fix in place.
 */
const PAYLOAD: UnsignedTx = {
  chain: 'solana',
  family: 'svm',
  summary: 'Burn 100000 tokens of mint 5pTy48…pump held by BTaPke…QFeH on Solana.',
  payload: {
    transaction: 'AQAAAAAAAAAAAAAAAAAA+/==',
    encoding: 'base64',
    feePayer: 'BTaPkeDYRuXbL6hEDsWPAWXUfZvjEoKoV3mCTQ91QFeH',
    recentBlockhash: 'CWfiHfTpYAFzMe13awoDSZ7GujXKfuTDks7R7unu1Sjd',
  },
  signingHint: 'Deserialize, sign, then sendRawTransaction.',
  warnings: ['This transaction is unsigned. Review every field before signing.'],
};

describe('telling the payload apart from the signature', () => {
  it('gives the signable string its own heading in Telegram', () => {
    const output = formatUnsignedTx(PAYLOAD);

    expect(output).toMatch(/Sign this string/);
    expect(output).toMatch(/it is not a signature/i);
    // And says what the thing it is not actually looks like, so the next step
    // is recognisable when it arrives.
    expect(output).toMatch(/88 characters/);
  });

  it('keeps the rest of the payload out of the way', () => {
    const output = formatUnsignedTx(PAYLOAD);

    // The fields still travel — a fee payer and a blockhash are worth seeing
    // before signing — they just stop competing with the one that matters.
    expect(output).toMatch(/Details/);
    expect(output).toMatch(/feePayer/);
    expect(output).toMatch(/recentBlockhash/);
    expect(output.indexOf('Sign this string')).toBeLessThan(output.indexOf('Details'));
  });

  it('survives a payload with no transaction field at all', () => {
    // Not every family returns one under that name; Cosmos and UTXO payloads
    // are shaped differently, and this formatter is shared.
    const cosmos = { ...PAYLOAD, payload: { body: '{}', accountNumber: '12' } };

    const output = formatUnsignedTx(cosmos);

    expect(output).toMatch(/accountNumber/);
    expect(output).not.toMatch(/Sign this string/);
  });

  it('says the same thing at the terminal', () => {
    const output = renderUnsignedTx(PAYLOAD);

    expect(output).toMatch(/this is not a signature/i);
    expect(output).toMatch(/produces a signature/i);
  });
});
