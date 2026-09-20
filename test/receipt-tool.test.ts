import { describe, it, expect } from 'vitest';
import { receiptArt } from '../src/tools/operations.js';
import { getTool } from '../src/tools/catalog.js';
import { renderQrArt } from '../src/art/qr-art.js';
import { qrMatrix } from '../src/core/qr.js';

/**
 * The tool an agent uses to answer "is this picture evidence of my payment?".
 *
 * The interesting assertions are the negative ones. A verifier that returns
 * true for everything is worse than none, because it converts "I have not
 * checked" into "I have checked" — so the tests below swap the image, swap the
 * reference, and tamper with the SVG, and each has to come back false.
 */

const REFERENCE = '695xPtsSYaSALQdwgE6WxC4zX49zZrpVPwF2uiUGjCBB';
const OTHER = '8kL2mNpQrStUvWxYz1A3B4C5D6E7F8G9H1J2K3L4M5N6';
const RECIPIENT = 'BTaPkeDYRuXbL6hEDsWPAWXUfZvjEoKoV3mCTQ91QFeH';
const LINK = `solana:${RECIPIENT}?amount=0.25&reference=${REFERENCE}`;

const genuine = renderQrArt(qrMatrix(LINK), REFERENCE, { scale: 8 });

describe('describing a receipt without touching the network', () => {
  it('derives traits from the reference alone', async () => {
    const result = await receiptArt({ reference: REFERENCE });

    expect(result.reference).toBe(REFERENCE);
    expect(result.source).toBe('reference');
    expect(result.traits.palette).toMatch(/\w+\/\w+/);
    expect(['square', 'rounded', 'dot', 'diamond']).toContain(result.traits.modules);
  });

  it('reports contrast, which is what decides whether it scans', async () => {
    const result = await receiptArt({ reference: REFERENCE });

    expect(result.contrast.inkOnPaper).toBeGreaterThan(7);
    expect(result.contrast.accentOnPaper).toBeGreaterThan(4.5);
  });

  it('reads the reference out of a receipt uri', async () => {
    const result = await receiptArt({ uri: `https://r.example.test/${REFERENCE}.json` });

    expect(result.reference).toBe(REFERENCE);
    expect(result.source).toBe('uri');
  });

  it('refuses a uri that does not carry one, and says why it matters', async () => {
    // The failure mode worth explaining: a uri without the reference means the
    // reference exists only in JSON a host can rewrite.
    await expect(receiptArt({ uri: 'https://r.example.test/7.json' })).rejects.toThrow(
      /off-chain JSON/i,
    );
  });

  it('refuses when given neither', async () => {
    await expect(receiptArt({})).rejects.toThrow(/reference/i);
  });

  it('renders the code only when given the link it encodes', async () => {
    expect((await receiptArt({ reference: REFERENCE })).svg).toBeUndefined();
    expect((await receiptArt({ reference: REFERENCE, link: LINK })).svg).toBe(genuine);
  });
});

describe('checking an image, which is the question worth asking', () => {
  it('accepts the picture the reference actually generates', async () => {
    const result = await receiptArt({ reference: REFERENCE, link: LINK, image: genuine });

    expect(result.matches).toBe(true);
    expect(result.note).toMatch(/evidence of that payment/i);
  });

  it('rejects a picture generated from a different payment', async () => {
    const swapped = renderQrArt(qrMatrix(LINK), OTHER, { scale: 8 });
    const result = await receiptArt({ reference: REFERENCE, link: LINK, image: swapped });

    expect(result.matches).toBe(false);
  });

  it('rejects a picture that was edited rather than replaced', async () => {
    const tampered = genuine.replace('</svg>', '<rect width="1" height="1"/></svg>');
    const result = await receiptArt({ reference: REFERENCE, link: LINK, image: tampered });

    expect(result.matches).toBe(false);
  });

  it('says a mismatch is not proof of fraud', async () => {
    // The distinction the note has to carry: "not evidence" and "fraudulent"
    // are different claims, and only the first is supported here.
    const result = await receiptArt({ reference: REFERENCE, link: LINK, image: '<svg/>' });

    expect(result.matches).toBe(false);
    expect(result.note).toMatch(/does not prove the payment is bad/i);
  });

  it('refuses to check an image without the link to compare against', async () => {
    await expect(receiptArt({ reference: REFERENCE, image: genuine })).rejects.toThrow(/link/i);
  });
});

describe('the tool, as the MCP catalog exposes it', () => {
  it('is registered', () => {
    expect(getTool('receipt_art')).toBeDefined();
  });

  it('is marked read-only, because it reads nothing at all', () => {
    const tool = getTool('receipt_art')!;
    expect(tool.annotations?.readOnlyHint).toBe(true);
  });

  it('tells an agent that a mismatch is not an accusation', () => {
    // The description is the only thing steering a model's phrasing when it
    // relays this to somebody, and "your receipt is fake" is the wrong
    // sentence to put in its mouth.
    expect(getTool('receipt_art')!.description).toMatch(/not proof of fraud/i);
  });

  it('runs through the catalog the same as directly', async () => {
    const viaTool = (await getTool('receipt_art')!.run({
      reference: REFERENCE,
      link: LINK,
      image: genuine,
    })) as { matches: boolean };

    expect(viaTool.matches).toBe(true);
  });
});
