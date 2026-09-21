import { describe, it, expect } from 'vitest';
import {
  checkAmounts,
  checkExpiry,
  classifyDemand,
  demandNote,
  demandVerdict,
  type DemandChain,
  type DemandFacts,
} from '../src/pay/demand.js';
import type { PaymentDemand } from '../src/pay/types.js';

/**
 * What a payment demand's readings mean, checked without a network.
 *
 * The judging is split from the reading for exactly this reason: every shape
 * below would otherwise need a live account of that exact kind, and the ones
 * that matter most — a token account holding the wrong mint, a frozen
 * destination, a mint address with no mint at it — are shapes nobody deploys on
 * purpose.
 *
 * The first block is not a hypothetical. It is the invoice
 * `agents.privatedao.org` served on 21 September 2026, field for field.
 */

const solana: DemandChain = {
  id: 'solana',
  name: 'Solana',
  nativeSymbol: 'SOL',
  nativeDecimals: 9,
};

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
/** The same address with one character missing. Still valid base58. */
const NOT_USDC = 'EPjFWdd5AufSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const TREASURY = '2BJ4ezxqV9YJXc38D9duKBkdn4su4jE1beKUHwH663sL';
const DEAD_ACCOUNT = 'L2iAzRuZZrubxcfkQXqBGpPHWej9vLMbm24cDT2jqbv';
const REAL_ATA = '5RyKShQxSkbUJ9vA2MZ1Qf2TKgnwhhS3m7mj2ZZaVh6t';

const codes = (findings: { code: string }[]) => findings.map((f) => f.code);

describe('the invoice that prompted this', () => {
  const demand: PaymentDemand = {
    asset: 'USDC',
    mint: NOT_USDC,
    amount: '0.010000',
    amountBaseUnits: '10000',
    decimals: 6,
    to: TREASURY,
    tokenAccount: DEAD_ACCOUNT,
  };

  it('refuses it on the ticker alone, before any chain read', () => {
    // The check that costs nothing and catches the whole class. Note the facts
    // here are empty: no network happened.
    const findings = classifyDemand(solana, demand, {}, USDC);
    expect(codes(findings)).toContain('ASSET_NOT_WHAT_IT_CLAIMS');
    expect(demandVerdict(findings, true)).toBe('unpayable');
  });

  it('names both addresses, because "mismatch" is not a reason', () => {
    const [asset] = classifyDemand(solana, demand, {}, USDC).filter(
      (f) => f.code === 'ASSET_NOT_WHAT_IT_CLAIMS',
    );
    expect(asset?.detail).toContain(USDC);
    expect(asset?.detail).toContain(NOT_USDC);
  });

  it('also refuses it for having no mint at that address', () => {
    const findings = classifyDemand(solana, demand, { mintMissing: true }, USDC);
    expect(codes(findings)).toContain('MINT_DOES_NOT_EXIST');
    expect(demandVerdict(findings, true)).toBe('unpayable');
  });

  it('stops looking once the mint is missing, rather than inventing findings', () => {
    // Everything downstream is measured against a mint. A validator that went
    // on to report the destination as "wrong" would be saying something it
    // cannot know.
    const findings = classifyDemand(solana, demand, { mintMissing: true }, USDC);
    expect(codes(findings)).not.toContain('DESTINATION_DOES_NOT_EXIST');
    expect(codes(findings)).not.toContain('AMOUNT_UNSTATED');
  });

  it('opens with "Do not pay this"', () => {
    const findings = classifyDemand(solana, demand, { mintMissing: true }, USDC);
    expect(demandNote(findings, 'unpayable')).toMatch(/^Do not pay this\./);
  });
});

describe('a destination that does not exist', () => {
  const demand: PaymentDemand = { mint: USDC, to: TREASURY, tokenAccount: DEAD_ACCOUNT, amount: '0.01' };
  const facts: DemandFacts = {
    mint: { address: USDC, decimals: 6, curatedSymbol: 'USDC' },
    derivedAta: REAL_ATA,
    destination: { address: DEAD_ACCOUNT, exists: false, isAssociated: false },
  };

  it('is fatal when the demand named that exact account', () => {
    expect(codes(classifyDemand(solana, demand, facts))).toContain('DESTINATION_DOES_NOT_EXIST');
    expect(demandVerdict(classifyDemand(solana, demand, facts), true)).toBe('unpayable');
  });

  it('points out that it is not the derived account either, and gives the one that is', () => {
    const notDerived = classifyDemand(solana, demand, facts).find(
      (f) => f.code === 'DESTINATION_NOT_DERIVED',
    );
    expect(notDerived?.detail).toContain(REAL_ATA);
  });

  it('is only a warning when nobody named it and it is simply uncreated', () => {
    // A payee with no token account yet is ordinary. The transfer needs one
    // created and that costs rent, which is a thing to know, not a refusal.
    const uncreated: PaymentDemand = { mint: USDC, to: TREASURY, amount: '0.01' };
    const findings = classifyDemand(solana, uncreated, {
      mint: { address: USDC, decimals: 6 },
      derivedAta: REAL_ATA,
      destination: { address: REAL_ATA, exists: false, isAssociated: true },
    });

    expect(codes(findings)).toContain('DESTINATION_UNCREATED');
    expect(demandVerdict(findings, true)).toBe('payable');
  });
});

describe('a destination that exists but is not what was claimed', () => {
  const base: DemandFacts = { mint: { address: USDC, decimals: 6 } };
  const demand: PaymentDemand = { mint: USDC, to: TREASURY, tokenAccount: DEAD_ACCOUNT, amount: '1' };

  it('refuses an account holding a different mint', () => {
    const findings = classifyDemand(solana, demand, {
      ...base,
      destination: { address: DEAD_ACCOUNT, exists: true, mint: NOT_USDC, owner: TREASURY },
    });
    expect(codes(findings)).toContain('DESTINATION_WRONG_MINT');
  });

  it('refuses an account belonging to somebody other than the payee', () => {
    const findings = classifyDemand(solana, demand, {
      ...base,
      destination: { address: DEAD_ACCOUNT, exists: true, mint: USDC, owner: REAL_ATA },
    });
    const wrong = findings.find((f) => f.code === 'DESTINATION_WRONG_OWNER');
    expect(wrong?.severity).toBe('fatal');
    // Both parties named, so the reader can tell who they would actually pay.
    expect(wrong?.detail).toContain(REAL_ATA);
    expect(wrong?.detail).toContain(TREASURY);
  });

  it('refuses a frozen account', () => {
    const findings = classifyDemand(solana, demand, {
      ...base,
      destination: { address: DEAD_ACCOUNT, exists: true, mint: USDC, owner: TREASURY, frozen: true },
    });
    expect(codes(findings)).toContain('DESTINATION_FROZEN');
  });

  it('accepts one that matches on every count', () => {
    const findings = classifyDemand(solana, demand, {
      ...base,
      destination: { address: DEAD_ACCOUNT, exists: true, mint: USDC, owner: TREASURY, frozen: false },
    });
    expect(findings).toEqual([]);
    expect(demandVerdict(findings, true)).toBe('payable');
    expect(demandNote(findings, 'payable')).toMatch(/can be paid as stated/);
  });
});

describe('numbers that disagree', () => {
  it('refuses a displayed amount that is not its own base units', () => {
    const findings = checkAmounts({ amount: '0.01', amountBaseUnits: '10000000' }, 6);
    const mismatch = findings.find((f) => f.code === 'AMOUNT_MISMATCH');
    expect(mismatch?.severity).toBe('fatal');
    // Says what the base units actually come to, which is the number signed.
    expect(mismatch?.detail).toContain('10');
  });

  it('accepts them when they agree', () => {
    expect(checkAmounts({ amount: '0.010000', amountBaseUnits: '10000' }, 6)).toEqual([]);
  });

  it('refuses decimals that disagree with the asset', () => {
    const findings = checkAmounts({ amount: '1', decimals: 9 }, 6);
    expect(codes(findings)).toContain('DECIMALS_MISMATCH');
  });

  it('refuses an amount finer than the asset divides', () => {
    // Usually means the amount was computed against a different asset's
    // decimals, which is worth saying rather than calling it unparseable.
    const findings = checkAmounts({ amount: '0.0000001' }, 6);
    expect(codes(findings)).toContain('AMOUNT_TOO_PRECISE');
    expect(findings[0]?.detail).toContain('7 decimal places');
  });

  it('refuses a payment for zero', () => {
    // Moves nothing while looking like a payment — the failure a boolean hides.
    expect(codes(checkAmounts({ amount: '0.000000' }, 6))).toContain('AMOUNT_IS_ZERO');
  });

  it('refuses a negative amount rather than parsing one', () => {
    expect(codes(checkAmounts({ amount: '-1' }, 6))).toContain('AMOUNT_NEGATIVE');
  });

  it('notes an unstated amount rather than assuming one', () => {
    expect(codes(checkAmounts({}, 6))).toContain('AMOUNT_UNSTATED');
  });
});

describe('expiry', () => {
  const now = Date.parse('2026-09-21T10:00:00.000Z');

  it('refuses a demand that has already lapsed', () => {
    const f = checkExpiry({ expiresAt: '2026-09-21T09:59:00.000Z' }, now);
    expect(f?.code).toBe('EXPIRED');
    expect(f?.severity).toBe('fatal');
  });

  it('warns when there is less time left than signing takes', () => {
    const f = checkExpiry({ expiresAt: '2026-09-21T10:00:30.000Z' }, now);
    expect(f?.code).toBe('EXPIRES_SOON');
    expect(f?.severity).toBe('warning');
  });

  it('says nothing about a demand with room to spare', () => {
    expect(checkExpiry({ expiresAt: '2026-09-21T10:15:00.000Z' }, now)).toBeUndefined();
  });

  it('notes an expiry it cannot read rather than ignoring it', () => {
    expect(checkExpiry({ expiresAt: 'soon' }, now)?.code).toBe('EXPIRY_UNREADABLE');
  });
});

describe('native payments', () => {
  it('refuses SOL aimed at a token account', () => {
    const findings = classifyDemand(
      solana,
      { to: DEAD_ACCOUNT, amount: '1' },
      { destination: { address: DEAD_ACCOUNT, exists: true }, recipientIsTokenAccount: true },
    );
    expect(codes(findings)).toContain('DESTINATION_IS_A_TOKEN_ACCOUNT');
  });

  it('does not mind a recipient that does not exist yet, because the transfer creates it', () => {
    const findings = classifyDemand(
      solana,
      { to: TREASURY, amount: '1' },
      { destination: { address: TREASURY, exists: false } },
    );
    expect(demandVerdict(findings, true)).toBe('payable');
  });

  it('checks the amount against SOL decimals, not a token’s', () => {
    const findings = classifyDemand(
      solana,
      { to: TREASURY, amount: '1', decimals: 6 },
      { destination: { address: TREASURY, exists: true } },
    );
    expect(codes(findings)).toContain('DECIMALS_MISMATCH');
  });
});

describe('a chain that would not answer', () => {
  const demand: PaymentDemand = { mint: USDC, to: TREASURY, amount: '1' };

  it('is unproven, never payable', () => {
    // The distinction the whole verdict type exists for: "I could not check" is
    // not "I checked and it is fine".
    const findings = classifyDemand(solana, demand, { unreadable: 'all endpoints failed' });
    expect(demandVerdict(findings, false)).toBe('unproven');
    expect(codes(findings)).toContain('CHAIN_UNREADABLE');
  });

  it('says so in the note rather than implying approval', () => {
    const findings = classifyDemand(solana, demand, { unreadable: 'all endpoints failed' });
    expect(demandNote(findings, 'unproven')).toMatch(/unchecked rather than as cleared/);
  });

  it('still refuses on what was already known offline', () => {
    // An unreachable endpoint does not rescue a demand whose own ticker gives
    // it away.
    const findings = classifyDemand(
      solana,
      { ...demand, asset: 'USDC', mint: NOT_USDC },
      { unreadable: 'all endpoints failed' },
      USDC,
    );
    expect(demandVerdict(findings, false)).toBe('unpayable');
  });
});

describe('malformed input is a finding, not a crash', () => {
  it('reports an address that will not parse', () => {
    const findings = classifyDemand(solana, { mint: 'not-an-address' }, { malformed: ['mint'] });
    expect(codes(findings)).toContain('ADDRESS_MALFORMED');
    expect(demandVerdict(findings, true)).toBe('unpayable');
  });
});

describe('ordering and summary', () => {
  it('puts fatal findings first, so the first one read is the worst', () => {
    const findings = classifyDemand(
      solana,
      { mint: USDC, to: TREASURY, tokenAccount: DEAD_ACCOUNT, amount: '0.01', amountBaseUnits: '999' },
      {
        mint: { address: USDC, decimals: 6 },
        derivedAta: REAL_ATA,
        destination: { address: DEAD_ACCOUNT, exists: false, isAssociated: false },
        risk: { mint: USDC, freezeAuthority: 'Freeze111', custodyIsYours: false, warnings: [] },
      },
    );

    expect(findings[0]?.severity).toBe('fatal');
    expect(findings.at(-1)?.severity).toBe('note');
    expect(demandNote(findings, 'unpayable')).toContain(findings[0]!.detail);
  });

  it('counts the fatal findings in the note', () => {
    const findings = classifyDemand(
      solana,
      { mint: USDC, to: TREASURY, tokenAccount: DEAD_ACCOUNT, amount: '0.01', amountBaseUnits: '999' },
      {
        mint: { address: USDC, decimals: 6 },
        destination: { address: DEAD_ACCOUNT, exists: true, mint: NOT_USDC, owner: REAL_ATA },
      },
    );
    expect(demandNote(findings, 'unpayable')).toMatch(/3 things make it unpayable/);
  });
});
