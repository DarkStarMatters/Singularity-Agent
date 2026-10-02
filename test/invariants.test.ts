import { describe, it, expect } from 'vitest';
import { completeness } from '../src/core/envelope.js';
import { amount } from '../src/core/format.js';
import {
  checkCut,
  checkFailedRead,
  checkNotFoundClaim,
  checkNotStronger,
  checkSearched,
  checkShape,
  INVARIANTS,
} from '../src/core/invariants.js';

/**
 * The checkers, against the shapes of the violations they exist for.
 *
 * `test/invariants.property.test.ts` drives the real tools through them; this
 * file holds that each checker flags the bug it is named after, in the shape
 * that bug actually shipped, and stays quiet on the honest version. A checker
 * that passes everything would make the property suite pass too.
 *
 * Of the roadmap's five, three are this kind (1, 2 and 4). The X filter (3)
 * was a classifier dropping genuine questions, which is a recall problem with
 * its own corpus test. The disabled asset check (5) was an alias that stopped a
 * check from running, and is held by the payment tests that pin it. Neither is
 * a response claiming more than it knows.
 */

describe('the six claims', () => {
  it('are the six the roadmap states, each with an id', () => {
    expect(Object.keys(INVARIANTS)).toHaveLength(6);
    expect(Object.values(INVARIANTS)).toContain('A failed read never becomes an empty result.');
  });
});

describe('violation one: Solana dust, cut without saying so', () => {
  it('flags a short list under a complete-sounding caveat', () => {
    const v = checkCut(12, 9, completeness.exhaustive('Every token account.'));
    expect(v).toHaveLength(1);
    expect(v[0]!.invariant).toBe('cut-says-so');
  });

  it('flags a truncation whose counts are wrong', () => {
    expect(checkCut(12, 9, completeness.truncated(10, 2, 'Cut.')).map((v) => v.detail)).toEqual([
      'Says it shows 10; it shows 9.',
      'Says it omitted 2; it omitted 3.',
    ]);
  });

  it('passes an honest truncation, and a page with no known total', () => {
    expect(checkCut(12, 9, completeness.truncated(9, 3, 'Cut.'))).toEqual([]);
    expect(checkCut(12, 9, completeness.paged(9, 'A page.'))).toEqual([]);
  });

  it('flags a truncated completeness missing its counts, wherever it sits', () => {
    const v = checkShape({ deep: { list: [{ completeness: { kind: 'truncated', note: 'Cut.' } }] } });
    expect(v).toEqual([expect.objectContaining({ invariant: 'cut-says-so', path: '$.deep.list[0].completeness' })]);
  });
});

describe('violation two: dropped failures that came back as []', () => {
  it('flags an empty list with any caveat but failed', () => {
    for (const reported of [completeness.exhaustive('All.'), completeness.curated('Some.')]) {
      expect(checkFailedRead(true, [], reported)[0]?.invariant).toBe('failure-is-not-empty');
    }
    expect(checkFailedRead(true, [], completeness.failed('The scan failed.'))).toEqual([]);
  });

  it('flags a caveat made stronger on the way through', () => {
    expect(checkNotStronger([completeness.curated('Nine tokens.')], completeness.exhaustive('All.'))).toHaveLength(1);
    expect(checkNotStronger([completeness.curated('x'), completeness.failed('y')], completeness.curated('z'))).toHaveLength(1);
    expect(checkNotStronger([completeness.curated('x')], completeness.failed('y'))).toEqual([]);
  });

  it('flags a caveat nobody can read', () => {
    expect(checkShape({ completeness: { kind: 'curated', note: ' ' } })[0]?.invariant).toBe('absence-needs-completeness');
  });
});

describe('violation four: "not found on any of" chains that never answered', () => {
  const record = { answered: ['ethereum'], failed: ['base', 'polygon'] };

  it('flags a failed chain listed as searched, and one left out entirely', () => {
    const v = checkSearched(record, { searched: ['ethereum', 'base'] });
    expect(v.map((x) => x.detail)).toEqual([
      'base is listed as searched and never answered.',
      'base failed and is not reported as unreachable.',
      'polygon failed and is not reported as unreachable.',
    ]);
  });

  it('passes the shape the fix returns', () => {
    expect(checkSearched(record, { searched: ['ethereum'], unreachable: [{ chain: 'base' }, { chain: 'polygon' }] })).toEqual([]);
  });

  it('reads the chains a not-found message names', () => {
    expect(checkNotFoundClaim(record, 'Transaction 0xab…cd was not found on any of: ethereum, base.')).toEqual([
      expect.objectContaining({ detail: 'Not found on base, which never answered.' }),
    ]);
    expect(checkNotFoundClaim(record, 'Transaction 0xab…cd was not found on any of: ethereum.')).toEqual([]);
    expect(checkNotFoundClaim({ answered: [], failed: ['base'] }, 'not found on any of: .')).toHaveLength(1);
  });
});

describe('the other two claims, in any output', () => {
  it('flags a payload that does not say it is unsigned', () => {
    const tx = { chain: 'solana', family: 'svm', summary: 's', payload: {}, signingHint: 'Sign it.', warnings: [] };
    expect(checkShape({ transaction: tx })[0]).toMatchObject({ invariant: 'unsigned-says-so', path: '$.transaction' });
    expect(checkShape({ transaction: { ...tx, unsigned: true } })).toEqual([]);
  });

  it('flags a total across different units, or one that does not add up', () => {
    const holding = (decimals: number, raw: string) => ({
      chain: 'ethereum',
      total: amount('300', 6, 'USDC'),
      addresses: [
        { address: 'a', amount: amount('100', 6, 'USDC') },
        { address: 'b', amount: amount(raw, decimals, 'USDC') },
      ],
    });

    expect(checkShape(holding(6, '200'))).toEqual([]);
    expect(checkShape(holding(18, '200')).map((v) => v.invariant)).toEqual(['totals-share-units']);
    expect(checkShape(holding(6, '250'))[0]?.detail).toBe('The total says 300 and its parts add up to 350.');
  });
});
