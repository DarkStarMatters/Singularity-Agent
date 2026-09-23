import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The payer's proof that a payment met its demand.
 *
 * `find_payment` is written for whoever is owed; this is written for whoever
 * paid, and the case that motivated it was real: a payment that landed three
 * seconds after a quote was issued, rejected by the payee as "quote expired".
 * Every term of the demand is a separate check here so that an answer like that
 * can be met with the block time and the deadline side by side.
 *
 * The shapes below follow the finalized `getParsedTransaction` of the 0.03 USDC
 * job paid to the PrivateDAO exchange on 2026-09-23.
 */

let transaction: unknown = null;
let signatureStatus: unknown = null;

vi.mock('@solana/web3.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@solana/web3.js')>();

  return {
    ...actual,
    Connection: class {
      async getParsedTransaction() {
        return transaction;
      }

      async getSignatureStatuses() {
        return { value: [signatureStatus] };
      }
    },
  };
});

const { PublicKey } = await import('@solana/web3.js');
const { provePayment } = await import('../src/tools/operations.js');

const SIGNATURE = '3C4s5ngiJP23vABg8h3rKWwZVnUaYNmaa3EhY3NhrdcBrMBdgqk3hkpdFEBqytGFEnZrVnQLRt6nHYb3nYXsYq6f';
const PAYER = 'BFnj2t3vUdBiccnk8URSecc88HkypE5tt9S5DMVRLuZ7';
const PAYER_ACCOUNT = '2CLNrELhgstD9XZFqGykjCPePULQwLUureGBT9pZdejz';
const TREASURY = '2BJ4ezxqV9YJXc38D9duKBkdn4su4jE1beKUHwH663sL';
const TREASURY_ACCOUNT = '5RyKShQxSkbUJ9vA2MZ1Qf2TKgnwhhS3m7mj2ZZaVh6t';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const LOOKALIKE = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const MEMO = 'PDAOJOB:job_33640e3c-5bdb-42bb-a250-129840776b37';

/** 13:18:59 UTC on 2026-09-23, the block the real payment landed in. */
const LANDED = 1790169539;

function balance(index: number, owner: string, raw: string, mint = USDC) {
  return {
    accountIndex: index,
    mint,
    owner,
    uiTokenAmount: { amount: raw, decimals: 6 },
  };
}

function usdcPayment(options: { mint?: string; memo?: string; err?: unknown; blockTime?: number | null } = {}) {
  const mint = options.mint ?? USDC;
  return {
    slot: 449714898,
    blockTime: options.blockTime === undefined ? LANDED : options.blockTime,
    transaction: {
      message: {
        accountKeys: [PAYER, PAYER_ACCOUNT, TREASURY_ACCOUNT, mint].map((key) => ({
          pubkey: new PublicKey(key),
        })),
        instructions: [{ program: 'spl-memo', parsed: options.memo ?? MEMO }],
      },
    },
    meta: {
      err: options.err ?? null,
      preBalances: [27655679, 0, 0, 0],
      postBalances: [27650679, 0, 0, 0],
      preTokenBalances: [balance(1, PAYER, '1031665', mint), balance(2, TREASURY, '18357852', mint)],
      postTokenBalances: [balance(1, PAYER, '1001665', mint), balance(2, TREASURY, '18387852', mint)],
      innerInstructions: [],
    },
  };
}

const DEMAND = {
  signature: SIGNATURE,
  to: TREASURY,
  amount: '0.03',
  mint: USDC,
  tokenAccount: TREASURY_ACCOUNT,
  memo: MEMO,
  expiresAt: '2026-09-23T13:38:50.376Z',
  from: PAYER,
};

const term = (proof: { checks: Array<{ term: string; holds: boolean | null }> }, name: string) =>
  proof.checks.find((check) => check.term === name)?.holds;

beforeEach(() => {
  transaction = usdcPayment();
  signatureStatus = null;
});

describe('a payment that met its demand', () => {
  it('is proven on every term it was held to', async () => {
    const proof = await provePayment(DEMAND);

    expect(proof.verdict).toBe('proven');
    expect(proof.checks.map((check) => check.term)).toEqual([
      'landed', 'recipient', 'mint', 'tokenAccount', 'amount', 'memo', 'deadline', 'payer',
    ]);
    expect(proof.checks.every((check) => check.holds === true)).toBe(true);
    expect(proof.paid?.formatted).toBe('0.03');
    expect(proof.at).toBe('2026-09-23T13:18:59.000Z');
    expect(proof.finality?.kind).toBe('final');
  });

  it('returns the memo as untrusted text, because the payer wrote it', async () => {
    const proof = await provePayment(DEMAND);
    expect(proof.memo?.text).toBe(MEMO);
    expect(proof.memo?.untrusted).toBe(true);
  });

  it('checks only the terms it was given', async () => {
    const proof = await provePayment({ signature: SIGNATURE, to: TREASURY, amount: '0.03', mint: USDC });
    expect(proof.verdict).toBe('proven');
    expect(proof.checks.map((check) => check.term)).toEqual(['landed', 'recipient', 'mint', 'amount']);
  });
});

describe('a payment that is real and still not this one', () => {
  it('names the lookalike mint rather than accepting the ticker', async () => {
    transaction = usdcPayment({ mint: LOOKALIKE });

    const proof = await provePayment(DEMAND);

    expect(proof.verdict).toBe('contradicted');
    expect(term(proof, 'mint')).toBe(false);
    expect(term(proof, 'amount')).toBe(false);
    expect(proof.checks.find((check) => check.term === 'mint')?.observed).toBe(LOOKALIKE);
  });

  it('shows the block time against the deadline when it landed late', async () => {
    const proof = await provePayment({ ...DEMAND, expiresAt: '2026-09-23T13:10:00Z' });

    expect(proof.verdict).toBe('contradicted');
    expect(term(proof, 'deadline')).toBe(false);
    expect(proof.checks.find((check) => check.term === 'deadline')?.observed).toBe(
      'landed 2026-09-23T13:18:59.000Z',
    );
  });

  it('refuses a short payment', async () => {
    const proof = await provePayment({ ...DEMAND, amount: '0.05' });
    expect(term(proof, 'amount')).toBe(false);
    expect(proof.note).toMatch(/amount/);
  });

  it('refuses a payment into a different account of the right owner', async () => {
    const proof = await provePayment({ ...DEMAND, tokenAccount: PAYER_ACCOUNT });
    expect(term(proof, 'tokenAccount')).toBe(false);
    expect(term(proof, 'recipient')).toBe(true);
  });

  it('refuses a memo that does not carry the reference', async () => {
    transaction = usdcPayment({ memo: 'hello' });
    const proof = await provePayment(DEMAND);
    expect(term(proof, 'memo')).toBe(false);
  });

  it('names who the funds actually left', async () => {
    const proof = await provePayment({ ...DEMAND, from: TREASURY });
    expect(term(proof, 'payer')).toBe(false);
    expect(proof.checks.find((check) => check.term === 'payer')?.observed).toBe(PAYER);
  });

  it('calls a failed transaction a payment to nobody', async () => {
    transaction = usdcPayment({ err: { InstructionError: [0, 'Custom'] } });

    const proof = await provePayment(DEMAND);

    expect(proof.verdict).toBe('contradicted');
    expect(proof.checks).toEqual([
      { term: 'landed', expected: 'finalized and successful', observed: 'failed', holds: false },
    ]);
  });
});

describe('what the chain cannot settle', () => {
  it('reports a confirmed payment as unproven, never proven', async () => {
    transaction = null;
    signatureStatus = { confirmationStatus: 'confirmed' };

    const proof = await provePayment(DEMAND);

    expect(proof.verdict).toBe('unproven');
    expect(proof.note).toMatch(/not finalized/);
  });

  it('reports a missing signature as unproven, not disproven', async () => {
    // Pruned history and a payment that never landed look the same from here.
    transaction = null;

    const proof = await provePayment(DEMAND);

    expect(proof.verdict).toBe('unproven');
    expect(proof.note).toMatch(/unproven, not disproven/);
  });

  it('does not hold an undated block to a deadline', async () => {
    transaction = usdcPayment({ blockTime: null });

    const proof = await provePayment(DEMAND);

    expect(term(proof, 'deadline')).toBeNull();
    expect(proof.verdict).toBe('unproven');
  });
});

describe('native SOL', () => {
  it('reads the lamport delta when no mint is named', async () => {
    transaction = {
      ...usdcPayment(),
      transaction: {
        message: {
          accountKeys: [PAYER, TREASURY].map((key) => ({ pubkey: new PublicKey(key) })),
          instructions: [],
        },
      },
      meta: {
        err: null,
        preBalances: [2_000_000_000, 500_000_000],
        postBalances: [999_995_000, 1_500_000_000],
        preTokenBalances: [],
        postTokenBalances: [],
        innerInstructions: [],
      },
    };

    const proof = await provePayment({ signature: SIGNATURE, to: TREASURY, amount: '1', from: PAYER });

    expect(proof.verdict).toBe('proven');
    expect(proof.paid?.formatted).toBe('1');
  });
});

describe('refusing what it cannot do', () => {
  it('says plainly that EVM proofs are not built yet', async () => {
    await expect(
      provePayment({ ...DEMAND, chain: 'ethereum' }),
    ).rejects.toThrow(/implemented for Solana/);
  });

  it('refuses a deadline that is not a date', async () => {
    await expect(provePayment({ ...DEMAND, expiresAt: 'soon' })).rejects.toThrow(/not a date/);
  });
});
