import { describe, it, expect, vi, afterEach } from 'vitest';
import { completeness } from '../src/core/envelope.js';
import { evidenceFrom, reviewReply } from '../src/x/honesty.js';
import type { ToolRun } from '../src/grok/tools.js';

/**
 * The gate between a composed reply and a permanent public post.
 *
 * The sentence it exists to stop is "that wallet is empty", written from a
 * curated nine-token scan of a chain with no indexer. The model is told the
 * caveat and usually honours it; this is what turns usually into always.
 */

const LIMIT = 260;

const run = (overrides: Partial<ToolRun> = {}): ToolRun => ({
  name: 'balance',
  arguments: {},
  result: '{}',
  ok: true,
  untrusted: false,
  ...overrides,
});

describe('evidence from a turn', () => {
  it('takes the weakest completeness across every tool call', () => {
    const evidence = evidenceFrom([
      run({ completeness: completeness.exhaustive('solana') }),
      run({ completeness: completeness.curated('ethereum') }),
    ]);

    expect(evidence.completeness?.kind).toBe('curated');
  });

  it('reports nothing when no tool stated a completeness', () => {
    expect(evidenceFrom([run(), run()]).completeness).toBeNull();
  });

  it('flags a turn that touched on-chain text', () => {
    expect(evidenceFrom([run(), run({ untrusted: true })]).untrusted).toBe(true);
    expect(evidenceFrom([run(), run()]).untrusted).toBe(false);
  });
});

describe('an absence claim on a partial scan', () => {
  const curated = evidenceFrom([run({ completeness: completeness.curated('major tokens only') })]);

  const CLAIMS = [
    'That address holds no tokens.',
    'The wallet is empty.',
    'It has nothing on Base.',
    'Nothing there besides ETH.',
    'That address holds none.',
    'Zero holdings on Arbitrum.',
    'It only holds ETH.',
    'It doesn’t hold any USDC.',
  ];

  it.each(CLAIMS)('catches and repairs: %s', (text) => {
    const verdict = reviewReply(text, curated, LIMIT);

    expect(verdict.publish).toBe(true);
    if (!verdict.publish) throw new Error('unreachable');

    // Repaired rather than dropped: going silent on someone who asked a real
    // question is its own failure.
    expect(verdict.caveated).toBe(true);
    expect(verdict.text).toContain(text.trim());
    expect(verdict.text).toMatch(/not a full enumeration/i);
    expect(verdict.text.length).toBeLessThanOrEqual(LIMIT);
  });

  it.each([
    'It holds 5 USDC and 0.2 ETH.',
    'Gas on Base is about 0.01 gwei right now.',
    'That transaction succeeded in block 19000000.',
    'Singularity is read-only and never signs anything.',
  ])('leaves an ordinary answer alone: %s', (text) => {
    const verdict = reviewReply(text, curated, LIMIT);

    expect(verdict.publish).toBe(true);
    if (!verdict.publish) throw new Error('unreachable');
    expect(verdict.caveated).toBe(false);
    expect(verdict.text).toBe(text);
  });

  it('allows the same claim when the scan really was exhaustive', () => {
    // On Solana token accounts are owned by the wallet, so "holds no tokens"
    // is a statement the data supports. Caveating it would be noise.
    const exhaustive = evidenceFrom([
      run({ completeness: completeness.exhaustive('every SPL mint held') }),
    ]);

    const verdict = reviewReply('That address holds no tokens.', exhaustive, LIMIT);
    expect(verdict.publish).toBe(true);
    if (!verdict.publish) throw new Error('unreachable');
    expect(verdict.caveated).toBe(false);
  });

  it('does not police a reply with no enumerable evidence behind it', () => {
    // A question about the project reaches no scan at all; there is nothing
    // here for this gate to check against, and inventing a caveat would be
    // worse than staying out of the way.
    const verdict = reviewReply('No, it holds no keys and never signs.', evidenceFrom([]), LIMIT);

    expect(verdict.publish).toBe(true);
    if (!verdict.publish) throw new Error('unreachable');
    expect(verdict.caveated).toBe(false);
  });
});

describe('totality claims', () => {
  const truncated = evidenceFrom([
    run({ completeness: completeness.truncated(50, 31, 'showing 50 of 81') }),
  ]);

  it.each([
    'That is all of their tokens.',
    'Every token it holds is listed above.',
    'That is the complete list.',
    'Those are its full holdings.',
  ])('catches the "this is everything" version: %s', (text) => {
    const verdict = reviewReply(text, truncated, LIMIT);

    expect(verdict.publish).toBe(true);
    if (!verdict.publish) throw new Error('unreachable');
    expect(verdict.caveated).toBe(true);
    expect(verdict.text).toMatch(/31 more were held/i);
  });
});

describe('when the correction will not fit', () => {
  it('withholds the reply rather than publishing the unsupported claim', () => {
    const curated = evidenceFrom([run({ completeness: completeness.curated('major tokens') })]);
    const long = `${'x'.repeat(240)} the wallet is empty.`;

    const verdict = reviewReply(long, curated, LIMIT);

    expect(verdict.publish).toBe(false);
    if (verdict.publish) throw new Error('unreachable');
    expect(verdict.reason).toMatch(/does not fit/i);
    expect(verdict.reason).toMatch(/curated/);
  });

  it('says why, so the refusal is not itself a silent failure', () => {
    const failed = evidenceFrom([run({ completeness: completeness.failed('every RPC failed') })]);
    const long = `${'x'.repeat(250)} it holds nothing.`;

    const verdict = reviewReply(long, failed, LIMIT);
    expect(verdict.publish).toBe(false);
    if (verdict.publish) throw new Error('unreachable');
    expect(verdict.reason).toContain('every RPC failed');
  });
});

describe('a failed scan is not an empty wallet', () => {
  it('repairs the claim with the reason the scan failed', () => {
    const failed = evidenceFrom([run({ completeness: completeness.failed('no contract answered') })]);

    const verdict = reviewReply('That wallet is empty.', failed, LIMIT);
    expect(verdict.publish).toBe(true);
    if (!verdict.publish) throw new Error('unreachable');
    expect(verdict.text).toMatch(/token scan failed/i);
    expect(verdict.text).toMatch(/not evidence of an empty wallet/i);
  });
});
