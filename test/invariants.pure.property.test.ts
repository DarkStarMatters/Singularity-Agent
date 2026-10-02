import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fc from 'fast-check';
import { PublicKey } from '@solana/web3.js';
import { checkShape } from '../src/core/invariants.js';
import { getTool } from '../src/tools/catalog.js';
import { allChains } from '../src/core/registry.js';

/**
 * The three tools that read no chain: `chains`, `decode` and `receipt_art`.
 *
 * A failed read cannot become an empty answer when there is no read to fail,
 * so the property here is the other half of Phase 7.2's last claim: nothing is
 * stated more strongly than its source supports. For `decode` the source that
 * matters is a public directory anyone may write to, and the claim is that its
 * answer never becomes `signature`. For `receipt_art` it is that an image is
 * called evidence of a payment only when it is exactly what that payment
 * generates. For `chains` it is that a filter returns what it says it does.
 */

const fetched: string[] = [];
let directory: 'down' | 'not-ok' | { signatures: string[] } = 'down';

const realFetch = globalThis.fetch;
beforeEach(() => {
  fetched.length = 0;
  globalThis.fetch = (async (input: string | URL) => {
    fetched.push(String(input));
    if (directory === 'down') throw new Error('network disabled in this test');
    if (directory === 'not-ok') return new Response('rate limited', { status: 429 });
    return new Response(JSON.stringify({ results: directory.signatures.map((text_signature) => ({ text_signature })) }), { status: 200 });
  }) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

async function run(tool: string, args: Record<string, unknown>) {
  try {
    return { ok: true as const, value: (await getTool(tool)!.run(args)) as Record<string, unknown> };
  } catch (error) {
    return { ok: false as const, error: error as Error & { code?: string } };
  }
}

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

describe('the tools that read no chain', () => {
  it('chains: a filter returns exactly what it matches, and nothing is listed twice', async () => {
    const all = allChains();
    const needle = fc.oneof(
      fc.constantFrom(...all.flatMap((c) => [c.id, c.nativeCurrency.symbol.toLowerCase(), ...(c.aliases ?? [])])),
      fc.string({ maxLength: 4 }),
    );
    const family = fc.option(fc.constantFrom('evm', 'svm', 'utxo', 'cosmos', 'tessarq'), { nil: undefined });

    await fc.assert(
      fc.asyncProperty(fc.option(needle, { nil: undefined }), family, async (query, fam) => {
        const result = await run('chains', { ...(query === undefined ? {} : { query }), ...(fam ? { family: fam } : {}) });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const listed = result.value as unknown as Array<{ id: string; family: string }>;

        const ids = listed.map((c) => c.id);
        expect(new Set(ids).size).toBe(ids.length);
        if (fam) expect(listed.every((c) => c.family === fam)).toBe(true);
        // With nothing to filter on, nothing may be missing.
        if (!query?.trim() && !fam) expect(ids.sort()).toEqual(all.map((c) => c.id).sort());
        expect(checkShape(listed)).toEqual([]);
      }),
      { numRuns: 200 },
    );
  });

  it('decode: a directory answer is never a signature, and without `lookup` nothing leaves the machine', async () => {
    const known = ['a9059cbb', '095ea7b3', '23b872dd', '70a08231', 'd0e30db0', '252dba42', '6a761202'];
    const data = fc.oneof(
      fc.uint8Array({ maxLength: 100 }).map(hex),
      fc.tuple(fc.constantFrom(...known), fc.uint8Array({ maxLength: 100 })).map(([sel, rest]) => sel + hex(rest)),
    );
    const prefixed = fc.tuple(data, fc.boolean()).map(([d, p]) => (p ? `0x${d}` : d));
    const answer = fc.oneof(
      fc.constantFrom<'down' | 'not-ok'>('down', 'not-ok'),
      fc.record({
        signatures: fc.array(
          fc.oneof(
            fc.constantFrom('transfer(address,uint256)', 'approve(address,uint256)', 'balanceOf(address)', 'f(uint256)', 'g()', 'h(bytes)'),
            fc.string({ maxLength: 40 }),
          ),
          { maxLength: 15 },
        ),
      }),
    );

    await fc.assert(
      fc.asyncProperty(prefixed, answer, async (calldata, dir) => {
        directory = dir;
        fetched.length = 0;
        const local = await run('decode', { data: calldata });
        expect(fetched, 'decode without `lookup` asked the network').toEqual([]);

        const looked = await run('decode', { data: calldata, lookup: true });
        expect(looked.ok).toBe(local.ok);
        if (!local.ok || !looked.ok) return;

        // What this tool recognized is the same with or without a stranger's opinion.
        expect(looked.value.signature).toBe(local.value.signature);
        expect(looked.value.args).toEqual(local.value.args);

        const candidates = (looked.value.candidates ?? []) as Array<{ untrusted?: boolean; args?: Array<{ untrusted?: boolean }> }>;
        if (local.value.signature || typeof dir === 'string') expect(candidates).toEqual([]);
        expect(candidates.length).toBeLessThanOrEqual(10);
        expect(candidates.every((c) => c.untrusted === true)).toBe(true);
        // Arguments only when one candidate alone fits; two that fit is no evidence for either.
        expect(candidates.filter((c) => c.args).length).toBeLessThanOrEqual(1);
        expect(candidates.every((c) => (c.args ?? []).every((a) => a.untrusted === true))).toBe(true);
        expect(checkShape(looked.value)).toEqual([]);
      }),
      { numRuns: 200 },
    );
  });

  it('receipt_art: an image is evidence of a payment only when it is exactly what that payment generates', async () => {
    const reference = fc.uint8Array({ minLength: 32, maxLength: 32 }).map((b) => new PublicKey(b).toBase58());
    const link = (ref: string) => `solana:BTaPkeDYRuXbL6hEDsWPAWXUfZvjEoKoV3mCTQ91QFeH?amount=1&reference=${ref}`;

    await fc.assert(
      fc.asyncProperty(reference, reference, fc.boolean(), async (a, b, viaUri) => {
        const source = viaUri ? { uri: `https://receipts.example/r/${a}.json` } : { reference: a };
        const own = await run('receipt_art', { ...source, link: link(a) });
        expect(own.ok).toBe(true);
        if (!own.ok) return;
        expect(own.value.reference).toBe(a);
        expect(own.value.source).toBe(viaUri ? 'uri' : 'reference');
        const svg = own.value.svg as string;

        const same = await run('receipt_art', { ...source, link: link(a), image: svg });
        expect(same.ok && same.value.matches).toBe(true);

        // Another payment's picture, and this one's with a byte changed, are not evidence of this one.
        const other = await run('receipt_art', { reference: b, link: link(b) });
        if (!other.ok) throw other.error;
        const theirs = await run('receipt_art', { ...source, link: link(a), image: other.value.svg });
        expect(theirs.ok && theirs.value.matches).toBe(a === b);

        const altered = await run('receipt_art', { ...source, link: link(a), image: svg.replace('<svg', '<svg data-x="1"') });
        expect(altered.ok && altered.value.matches).toBe(false);
        expect(checkShape(own.value)).toEqual([]);
      }),
      { numRuns: 25 },
    );
  });
});
