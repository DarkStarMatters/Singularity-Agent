import { describe, it, expect } from 'vitest';
import { applyBudget, budgetNote, itemBudget, parseBudget } from '../src/core/budget.js';
import { completeness } from '../src/core/envelope.js';
import { toolSchemas } from '../src/grok/tools.js';

/**
 * A budget shortens lists, which is the single operation that produced the two
 * worst bugs this project has shipped. So these tests are weighted the way the
 * Contributing note asks for: most of them check what a budget *lets through*
 * unchanged, because a cap measured only against the thing it blocks is how the
 * X filter shipped dropping 18 of 24 genuine questions while passing 41 tests.
 */

const BOUNDS = { fallback: 25, ceiling: 100 };

/** The note a budget-driven cut writes, for the tests that exercise one. */
const note = (shown: number, omitted: number) => budgetNote(shown, omitted, 'things');

describe('itemBudget', () => {
  it('returns the source default when nobody states a budget', () => {
    // The whole compatibility claim rests on this one line: adding the
    // parameter changed no existing answer, because absence still means the
    // number that shipped.
    expect(itemBudget(undefined, BOUNDS)).toBe(25);
  });

  it("treats 'standard' as the source's own default, not a number of its own", () => {
    expect(itemBudget('standard', BOUNDS)).toBe(25);
    expect(itemBudget('standard', { fallback: 50, ceiling: 200 })).toBe(50);
  });

  it('gives a small budget ten items', () => {
    expect(itemBudget('small', BOUNDS)).toBe(10);
  });

  it("gives a full budget the source's ceiling and never more", () => {
    expect(itemBudget('full', BOUNDS)).toBe(100);
    expect(itemBudget('full', { fallback: 50, ceiling: 200 })).toBe(200);
  });

  it('honours an exact count inside the ceiling', () => {
    expect(itemBudget({ maxItems: 7 }, BOUNDS)).toBe(7);
    expect(itemBudget({ maxItems: 99 }, BOUNDS)).toBe(99);
  });

  it('clamps an exact count to the ceiling rather than obeying it', () => {
    // `full` is a request for this source's maximum. Nothing, including an
    // explicit number, is a request for an unbounded response — that is the
    // 1.27 MB Solana balance, and it is not reachable through this parameter.
    expect(itemBudget({ maxItems: 10_000 }, BOUNDS)).toBe(100);
  });

  it('takes the smaller when a budget and an explicit limit disagree', () => {
    // No precedence rule to remember: both readings of the pair are requests
    // for less, and honouring the stricter one is never the wrong answer.
    expect(itemBudget('small', BOUNDS, 200)).toBe(10);
    expect(itemBudget('full', BOUNDS, 5)).toBe(5);
    expect(itemBudget(undefined, BOUNDS, 3)).toBe(3);
  });

  it('never returns less than one item', () => {
    // Zero would produce an empty list carrying a truncation note — a shape
    // every downstream reader mishandles, and nobody's actual intent.
    expect(itemBudget({ maxItems: 0 }, BOUNDS)).toBe(1);
    expect(itemBudget({ maxItems: -5 }, BOUNDS)).toBe(1);
    expect(itemBudget('small', BOUNDS, 0)).toBe(1);
  });
});

describe('applyBudget — what it lets through', () => {
  const items = [1, 2, 3];

  it('returns the list untouched when it already fits', () => {
    const claim = completeness.exhaustive('all of it');
    const result = applyBudget(items, 10, claim, note);

    expect(result.entries).toEqual([1, 2, 3]);
    // Identity, not just equality: an untouched list must carry the *same*
    // claim, so `exhaustive` still means exhaustive and an empty result may
    // still be read as "there is none".
    expect(result.completeness).toBe(claim);
  });

  it('leaves a list that exactly fills its budget exhaustive', () => {
    // The off-by-one that would turn a complete answer into a truncated one.
    const result = applyBudget(items, 3, completeness.exhaustive('all of it'), note);

    expect(result.entries).toHaveLength(3);
    expect(result.completeness.kind).toBe('exhaustive');
    expect(result.completeness.omitted).toBeUndefined();
  });

  it('leaves an empty list exhaustive, so absence still means absence', () => {
    const result = applyBudget([], 10, completeness.exhaustive('holds nothing'), note);

    expect(result.entries).toEqual([]);
    expect(result.completeness.kind).toBe('exhaustive');
  });
});

describe('applyBudget — what it cuts', () => {
  const many = Array.from({ length: 30 }, (_, i) => i);

  it('cuts to the budget and reports both counts', () => {
    const result = applyBudget(many, 10, completeness.exhaustive('all of it'), note);

    expect(result.entries).toHaveLength(10);
    expect(result.entries[0]).toBe(0);
    expect(result.completeness.kind).toBe('truncated');
    expect(result.completeness.shown).toBe(10);
    expect(result.completeness.omitted).toBe(20);
  });

  it('says the budget did the cutting, not the chain', () => {
    // The difference between "there is no more" and "ask again for more".
    // Only one of those is fixed by raising a parameter, so the note names it.
    const result = applyBudget(many, 10, completeness.exhaustive('all of it'), note);

    expect(result.completeness.note).toContain('Showing 10 of 30');
    expect(result.completeness.note).toContain('response budget');
    expect(result.completeness.note).toContain('Raise `budget`');
  });

  it('never upgrades a curated list into a plain truncation', () => {
    // Truncation is an additional limit, not a replacement for the one already
    // there: "these 10 of 30" must not erase "and 30 was only the curated set".
    const result = applyBudget(
      many,
      10,
      completeness.curated(
        'Covers a curated list of 30 major tokens; a token outside it is invisible here.',
      ),
      note,
    );

    expect(result.completeness.kind).toBe('truncated');
    expect(result.completeness.note).toContain('Showing 10 of 30');
    expect(result.completeness.note).toContain('invisible here');
  });

  it('restates the counts when an already-truncated list is cut again', () => {
    // The equal-rank case, which `weakest` alone gets wrong. Carrying the
    // earlier caveat is right; carrying the earlier *numbers* would describe a
    // list longer than the one actually returned.
    const result = applyBudget(
      many,
      10,
      completeness.truncated(30, 500, 'The chain would only page 30 of 530.'),
      note,
    );

    expect(result.completeness.shown).toBe(10);
    expect(result.completeness.omitted).toBe(20);
    expect(result.completeness.note).toContain('530');
  });

  it('leaves a failed scan failed however short it is cut', () => {
    // A scan that could not answer does not become a truncated success by
    // being shortened, and its counts would be counts of nothing.
    const result = applyBudget(
      many,
      10,
      completeness.failed('No contract answered, so nothing is known.'),
      note,
    );

    expect(result.entries).toHaveLength(10);
    expect(result.completeness.kind).toBe('failed');
    expect(result.completeness.note).toContain('nothing is known');
  });
});

describe('parseBudget', () => {
  it('accepts the three names', () => {
    expect(parseBudget('small')).toBe('small');
    expect(parseBudget('standard')).toBe('standard');
    expect(parseBudget('full')).toBe('full');
  });

  it('reads a bare number as an exact count', () => {
    // What a model actually emits against the tool schema.
    expect(parseBudget(40)).toEqual({ maxItems: 40 });
    expect(parseBudget(1)).toEqual({ maxItems: 1 });
    expect(parseBudget(12.7)).toEqual({ maxItems: 12 });
  });

  it('accepts the object form the internal type uses', () => {
    expect(parseBudget({ maxItems: 40 })).toEqual({ maxItems: 40 });
  });

  it('treats anything unusable as no budget at all', () => {
    // The one failure mode worth designing out: a malformed budget must not
    // shrink an answer, because a caller cannot tell a bad argument from a
    // wallet that genuinely holds less.
    expect(parseBudget('ful')).toBeUndefined();
    expect(parseBudget(0)).toBeUndefined();
    expect(parseBudget(-1)).toBeUndefined();
    expect(parseBudget(Number.NaN)).toBeUndefined();
    expect(parseBudget(null)).toBeUndefined();
    expect(parseBudget(undefined)).toBeUndefined();
    expect(parseBudget({ maxItems: 'lots' })).toBeUndefined();
    expect(parseBudget({})).toBeUndefined();
  });
});

describe('the budget as callers actually see it', () => {
  it('converts to JSON Schema rather than throwing at startup', () => {
    // `toJsonSchema` refuses anything it cannot render, by design — it throws
    // loudly rather than emitting `{}`, which a model reads as "takes
    // anything". That makes it a startup-time failure for the Grok front end,
    // so the shape of `budget` is pinned here rather than discovered live.
    expect(() => toolSchemas()).not.toThrow();

    const history = toolSchemas().find((tool) => tool.function.name === 'history');
    const budget = history?.function.parameters.properties?.budget;

    expect(budget?.type).toEqual(['string', 'number']);
    expect(budget?.description).toContain('small');
  });

  it('offers a budget on every tool that returns a list', () => {
    const schemas = toolSchemas();

    for (const name of ['balance', 'portfolio', 'history']) {
      const tool = schemas.find((candidate) => candidate.function.name === name);
      expect(tool?.function.parameters.properties?.budget, `${name} needs a budget`).toBeTruthy();
    }
  });

  it('never makes the budget required', () => {
    // Omitting it has to stay the default path, or every existing caller
    // breaks and the compatibility claim above is worthless.
    for (const tool of toolSchemas()) {
      expect(tool.function.parameters.required ?? []).not.toContain('budget');
    }
  });
});
