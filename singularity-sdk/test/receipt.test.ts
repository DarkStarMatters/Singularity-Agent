import { describe, it, expect } from 'vitest';
import { createPay } from '../src/pay.js';
import {
  InMemoryIntentStore,
  qrMatrix,
  qrArtPng,
  renderQrArt,
  styleFor,
  verifyReceiptImage,
} from 'singularity-agent';
import type { SettlementResult, StoredIntent } from 'singularity-agent';

/**
 * The SDK and the agent are supposed to be one system, not two that resemble
 * each other.
 *
 * That claim is cheap to make and easy to break: both sides render QR codes,
 * both derive a style, and nothing stops them drifting apart a release at a
 * time until a customer comparing the code in a chat message against the one
 * in a checkout page sees two different pictures. The assertions below are
 * byte-for-byte against the agent's own renderers for exactly that reason —
 * they fail the moment the two halves stop agreeing.
 *
 * The seed is what makes that possible without coordination. It comes out of
 * the link, which already has to carry the reference, so neither side has to
 * be told anything.
 */

const RECIPIENT = 'BTaPkeDYRuXbL6hEDsWPAWXUfZvjEoKoV3mCTQ91QFeH';
const REFERENCE = '695xPtsSYaSALQdwgE6WxC4zX49zZrpVPwF2uiUGjCBB';
const SIGNATURE = '5x7Kqf9Qw2vMhT3bN8pLzR4cY6dA1eF0gH2jK3mN4pQ5rS6tU7vW8xY9zA1bC2dE3f';

const LINK = `solana:${RECIPIENT}?amount=0.25&reference=${REFERENCE}&label=Singularity`;

const pay = createPay({ store: new InMemoryIntentStore(), endpoint: 'https://pay.example.test/i' });

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

const settled = {
  intent,
  level: 'final',
  signature: SIGNATURE,
  at: '2026-09-20T10:02:11.000Z',
  mismatches: [],
  note: 'Finalized and matching the claim.',
  fulfil: true,
} as SettlementResult;

describe('the SDK renders what the agent renders', () => {
  it('produces the agent SVG bytes exactly, for the same link', () => {
    const rendered = pay.qr(LINK);
    expect(rendered.svg).toBe(renderQrArt(qrMatrix(LINK), REFERENCE, { scale: 8 }));
  });

  it('produces the agent PNG bytes exactly, for the same link', () => {
    // The bytes Telegram receives and the bytes a web checkout receives.
    const rendered = pay.qr(LINK);
    const direct = qrArtPng(qrMatrix(LINK), REFERENCE, { scale: 8 });
    expect(Buffer.from(rendered.png).equals(Buffer.from(direct))).toBe(true);
  });

  it('takes its seed from the reference in the link, not from the link', () => {
    // Two links to the same payment that differ in a cosmetic parameter get
    // the same style, because they are the same payment. Not the same SVG —
    // the encoded content differs, so the matrix differs, and it must: the
    // style decides how a module is drawn and never which modules exist.
    const withMemo = `${LINK}&memo=order-7`;

    expect(pay.qr(withMemo).style).toEqual(pay.qr(LINK).style);
    expect(pay.qr(withMemo).svg).not.toBe(pay.qr(LINK).svg);
  });

  it('falls back to the whole link when there is no reference', () => {
    const plainLink = 'solana:BTaPkeDYRuXbL6hEDsWPAWXUfZvjEoKoV3mCTQ91QFeH?amount=1';
    expect(pay.qr(plainLink).svg).toBe(renderQrArt(qrMatrix(plainLink), plainLink, { scale: 8 }));
  });

  it('reports the style it drew, so a checkout can preview the receipt', () => {
    expect(pay.qr(LINK).style).toEqual(styleFor(REFERENCE));
  });

  it('still renders a plain code on request', () => {
    const plain = pay.qr(LINK, { plain: true });
    expect(plain.style).toBeUndefined();
    expect(plain.svg).not.toBe(pay.qr(LINK).svg);
  });

  it('leaves unicode alone, since a terminal has no geometry to style', () => {
    expect(pay.qr(LINK).unicode).toBe(pay.qr(LINK, { plain: true }).unicode);
  });
});

describe('receipts, through the SDK', () => {
  it('builds facts, artwork and metadata from a settled payment', () => {
    const bundle = pay.receipt(settled);

    expect(bundle.facts.signature).toBe(SIGNATURE);
    expect(bundle.image.startsWith('<svg')).toBe(true);
    expect(bundle.metadata['name']).toBe('Receipt 695xPtsS');
  });

  it('produces artwork that verifies against the reference', () => {
    // The property that makes the token evidence rather than decoration.
    const bundle = pay.receipt(settled);
    expect(verifyReceiptImage(bundle.facts, bundle.image)).toBe(true);
  });

  it('withholds the mint until there is a uri and a payer to point at', () => {
    // The metadata has to be hosted before a transaction can reference it, and
    // that round trip is the caller's to make.
    expect(pay.receipt(settled).mint).toBeUndefined();
    expect(pay.receipt(settled, { uri: 'https://example.test/r.json' }).mint).toBeUndefined();
  });

  it('builds the unsigned mint once both are supplied', () => {
    const bundle = pay.receipt(settled, {
      uri: 'https://example.test/r.json',
      payer: RECIPIENT,
    });

    expect(bundle.mint?.transaction.instructions).toHaveLength(6);
    expect(bundle.mint?.transaction.feePayer?.toBase58()).toBe(RECIPIENT);
  });

  it('hands back the throwaway mint key rather than using it', () => {
    // The one key this system generates. The SDK does not sign with it.
    const bundle = pay.receipt(settled, { uri: 'https://example.test/r.json', payer: RECIPIENT });
    expect(bundle.mint?.mintKeypair.publicKey.equals(bundle.mint.mint)).toBe(true);
  });

  it('refuses a payment that is not final', () => {
    const pending = { ...settled, level: 'probabilistic' } as SettlementResult;
    expect(() => pay.receipt(pending)).toThrow(/final/i);
  });

  it('refuses a payment that does not match the claim', () => {
    const wrong = { ...settled, mismatches: ['amount: expected 0.25, got 0.01'] } as SettlementResult;
    expect(() => pay.receipt(wrong)).toThrow(/does not match/i);
  });

  it('accepts a payer as a string, without needing web3.js', () => {
    // An application reads an address off a request or a chat message. Making
    // it wrap that in a PublicKey would mean taking a dependency to pass an
    // argument.
    expect(() =>
      pay.receipt(settled, { uri: 'https://example.test/r.json', payer: RECIPIENT }),
    ).not.toThrow();
  });
});
