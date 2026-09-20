import { describe, it, expect } from 'vitest';
import {
  classifyExitRisks,
  exitVerdict,
  sortBySeverity,
  type MintExitFacts,
} from '../src/trade/classify.js';
import type { ExitMechanism } from '../src/trade/types.js';

/**
 * What a mint's fields mean for somebody trying to sell.
 *
 * Testable without a network because the judging is split from the reading, and
 * split for exactly this reason: every combination below is cheap to check here
 * and would need a live mint of that exact shape otherwise.
 */

const bare: MintExitFacts = { mint: 'Mint1111111111111111111111111111111111111111' };

const mechanisms = (facts: MintExitFacts): ExitMechanism[] =>
  classifyExitRisks(facts).map((risk) => risk.mechanism);

const severityOf = (facts: MintExitFacts, mechanism: ExitMechanism) =>
  classifyExitRisks(facts).find((risk) => risk.mechanism === mechanism)?.severity;

describe('a mint with nothing on it', () => {
  it('produces no risks at all', () => {
    // A renounced mint is the point of renouncing. An empty list here is a real
    // answer, not a failure to look.
    expect(classifyExitRisks(bare)).toEqual([]);
  });

  it('is sellable and uncontrolled', () => {
    // No risks at all is the strongest answer this can give, and it is still
    // not "safe to buy" — nothing here looked at liquidity.
    expect(exitVerdict([])).toEqual({ canExit: true, underThirdPartyControl: false });
    expect(exitVerdict(classifyExitRisks(bare))).toEqual({
      canExit: true,
      underThirdPartyControl: false,
    });
  });
});

describe('mechanisms that stop a sale outright', () => {
  it('flags a non-transferable mint as blocking', () => {
    expect(severityOf({ ...bare, nonTransferable: true }, 'non-transferable')).toBe('blocks');
    expect(exitVerdict(classifyExitRisks({ ...bare, nonTransferable: true })).canExit).toBe(false);
  });

  it('flags a hook with a program set as blocking, and names the program', () => {
    const risks = classifyExitRisks({
      ...bare,
      hasTransferHookExtension: true,
      transferHookProgram: 'Hook111',
    });
    const hook = risks.find((risk) => risk.mechanism === 'transfer-hook');

    expect(hook?.severity).toBe('blocks');
    expect(hook?.holder).toBe('Hook111');
    expect(hook?.note).toMatch(/runs on the sale as well as the purchase/);
  });

  it('does NOT block on a hook extension with no program set', () => {
    // PYUSD ships exactly this shape. Refusing on the presence of the extension
    // alone would condemn a major stablecoin that transfers perfectly well —
    // the same mistake `transferExtensionWarnings` already documents.
    const risks = classifyExitRisks({ ...bare, hasTransferHookExtension: true });
    const hook = risks.find((risk) => risk.mechanism === 'transfer-hook');

    expect(hook?.severity).toBe('degrades');
    expect(hook?.holder).toBeUndefined();
    expect(exitVerdict(risks).canExit).toBe(true);
  });
});

describe('mechanisms a named party controls', () => {
  it.each([
    ['freezeAuthority', 'freeze-authority'],
    ['permanentDelegate', 'permanent-delegate'],
  ] as const)('treats %s as discretionary, not blocking', (field, mechanism) => {
    const facts = { ...bare, [field]: 'Holder111' } as MintExitFacts;
    const risks = classifyExitRisks(facts);

    expect(severityOf(facts, mechanism)).toBe('discretionary');
    // The distinction the whole type exists for: still sellable today.
    expect(exitVerdict(risks)).toEqual({ canExit: true, underThirdPartyControl: true });
  });

  it('names who holds the power, because whether you mind depends on who', () => {
    const risks = classifyExitRisks({ ...bare, freezeAuthority: 'Circle111' });
    expect(risks[0]?.holder).toBe('Circle111');
    expect(risks[0]?.note).toContain('Circle111');
  });

  it('treats a default-frozen account state as discretionary', () => {
    expect(severityOf({ ...bare, hasDefaultAccountState: true }, 'default-frozen')).toBe(
      'discretionary',
    );
  });

  it('reports a permanent delegate as seizure, not merely a freeze', () => {
    // The mechanism that rug-checkers built for SPL Token miss entirely, and
    // the reason PYUSD is worth inspecting: it is a clawback, not a lock.
    const risks = classifyExitRisks({ ...bare, permanentDelegate: 'Paxos111' });
    expect(risks[0]?.note).toMatch(/transfer or burn .* out of any wallet/);
    expect(risks[0]?.note).toMatch(/not the same as owning it/);
  });
});

describe('mechanisms that only make the exit worse', () => {
  it('treats a transfer fee as degrading', () => {
    expect(severityOf({ ...bare, hasTransferFee: true }, 'transfer-fee')).toBe('degrades');
  });

  it('treats a live mint authority as dilution, never as a custody problem', () => {
    // Supply growth is a reason to price differently, not a reason to doubt
    // that the balance in hand is yours.
    const facts = { ...bare, mintAuthority: 'Issuer111' };
    expect(severityOf(facts, 'mint-authority')).toBe('degrades');
    expect(exitVerdict(classifyExitRisks(facts))).toEqual({
      canExit: true,
      underThirdPartyControl: false,
    });
  });
});

describe('the two headline facts stay separate', () => {
  it('reports a USDC-shaped mint as sellable AND controlled', () => {
    // The live run that forced the three-way split. Collapsing these reported
    // USDC identically to a soulbound token.
    const usdcShaped = { ...bare, freezeAuthority: 'Circle111', mintAuthority: 'Circle111' };
    const verdict = exitVerdict(classifyExitRisks(usdcShaped));

    expect(verdict.canExit).toBe(true);
    expect(verdict.underThirdPartyControl).toBe(true);
  });

  it('reports a soulbound mint as neither', () => {
    const verdict = exitVerdict(classifyExitRisks({ ...bare, nonTransferable: true }));

    expect(verdict.canExit).toBe(false);
    expect(verdict.underThirdPartyControl).toBe(false);
  });

  it('reports a renounced mint as sellable and uncontrolled', () => {
    expect(exitVerdict(classifyExitRisks(bare))).toEqual({
      canExit: true,
      underThirdPartyControl: false,
    });
  });
});

describe('ordering', () => {
  it('puts the worst first, so a reader who stops early stops on the worst', () => {
    const risks = classifyExitRisks({
      ...bare,
      mintAuthority: 'M',
      freezeAuthority: 'F',
      nonTransferable: true,
    });

    expect(sortBySeverity(risks).map((risk) => risk.severity)).toEqual([
      'blocks',
      'discretionary',
      'degrades',
    ]);
  });

  it('does not mutate the list it was given', () => {
    const risks = classifyExitRisks({ ...bare, mintAuthority: 'M', nonTransferable: true });
    const before = risks.map((risk) => risk.mechanism);
    sortBySeverity(risks);
    expect(risks.map((risk) => risk.mechanism)).toEqual(before);
  });
});

describe('every mechanism produces exactly one entry', () => {
  it('finds all of them on a mint carrying everything', () => {
    const everything: MintExitFacts = {
      mint: 'Mint111',
      mintAuthority: 'M',
      freezeAuthority: 'F',
      permanentDelegate: 'D',
      transferHookProgram: 'H',
      hasTransferHookExtension: true,
      hasTransferFee: true,
      hasDefaultAccountState: true,
      nonTransferable: true,
    };

    const found = mechanisms(everything);

    expect(new Set(found).size).toBe(found.length);
    expect(found).toEqual(
      expect.arrayContaining([
        'non-transferable',
        'transfer-hook',
        'permanent-delegate',
        'freeze-authority',
        'default-frozen',
        'transfer-fee',
        'mint-authority',
      ]),
    );
  });

  it('finds none of them on a mint carrying nothing', () => {
    expect(mechanisms({ mint: 'M', hasTransferHookExtension: false, hasTransferFee: false })).toEqual(
      [],
    );
  });

  it('always names the subject in the note, so a warning can be acted on', () => {
    const risks = classifyExitRisks({
      mint: 'Mint1111111111111111111111111111111111111111',
      mintAuthority: 'Issuer999',
      freezeAuthority: 'Freezer999',
      permanentDelegate: 'Delegate999',
      hasTransferFee: true,
    });

    for (const risk of risks) {
      expect(risk.note.length, risk.mechanism).toBeGreaterThan(40);

      // A note names the party holding the power where there is one, and the
      // mint otherwise. The mint is shortened for prose, so match its stem.
      const names = risk.holder ? risk.note.includes(risk.holder) : /Mint11/.test(risk.note);
      expect(names, `${risk.mechanism}: ${risk.note}`).toBe(true);
    }
  });
});
