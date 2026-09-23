import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Buying a job, either side of the signature this package never makes.
 *
 * The exchange is faked and the two chain operations are stubbed, so these
 * tests are about the order and the refusals: what gets submitted, what never
 * does, and which of landed, credited and verified each ending actually earns.
 * The job, intent and receipt are the recorded shapes of the first credited
 * purchase, 2026-09-23.
 */

const provePayment = vi.fn();
const payDemand = vi.fn();

vi.mock('../src/tools/operations.js', () => ({ provePayment, payDemand }));

const { quoteJob, settleJob, termsFromIntent } = await import('../src/exchange/buy.js');

const JOB_ID = 'job_33640e3c-5bdb-42bb-a250-129840776b37';
const SIGNATURE = '3C4s5ngiJP23vABg8h3rKWwZVnUaYNmaa3EhY3NhrdcBrMBdgqk3hkpdFEBqytGFEnZrVnQLRt6nHYb3nYXsYq6f';
const PAYER = 'BFnj2t3vUdBiccnk8URSecc88HkypE5tt9S5DMVRLuZ7';
const INPUT = { network: 'solana-mainnet-beta', asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' };

const RECORDED = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'privatedao-job-2026-09-23.json'), 'utf8'),
) as { result: unknown; receipt: Record<string, unknown> };

/** As `create_paid_job` returned it. */
const CREATE_INTENT = {
  jobId: JOB_ID,
  status: 'awaiting_payment',
  asset: 'USDC',
  mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  amount: '0.030000',
  amountBaseUnits: '30000',
  decimals: 6,
  treasuryOwner: '2BJ4ezxqV9YJXc38D9duKBkdn4su4jE1beKUHwH663sL',
  treasuryTokenAccount: '5RyKShQxSkbUJ9vA2MZ1Qf2TKgnwhhS3m7mj2ZZaVh6t',
  recipient: '2BJ4ezxqV9YJXc38D9duKBkdn4su4jE1beKUHwH663sL',
  paymentReference: `PDAOJOB:${JOB_ID}`,
  expiresAt: '2026-09-23T13:38:50.376Z',
  expiresAtUtc: '2026-09-23T13:38:50.376Z',
};

/** As `GET /api/jobs/{id}/payment-intent` returned it — fewer fields, other spellings. */
const HTTP_INTENT = {
  jobId: JOB_ID,
  amount: '0.030000',
  amountBaseUnits: '30000',
  mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  treasuryOwner: '2BJ4ezxqV9YJXc38D9duKBkdn4su4jE1beKUHwH663sL',
  treasuryTokenAccount: '5RyKShQxSkbUJ9vA2MZ1Qf2TKgnwhhS3m7mj2ZZaVh6t',
  paymentReference: `PDAOJOB:${JOB_ID}`,
  expiresAtUtc: '2026-09-23T13:38:50.376Z',
};

const COMPLETED = { job_id: JOB_ID, status: 'completed', result: RECORDED.result, receipt: RECORDED.receipt };

function proof(verdict: 'proven' | 'contradicted' | 'unproven') {
  return {
    verdict,
    signature: SIGNATURE,
    checks:
      verdict === 'contradicted'
        ? [{ term: 'amount', expected: '0.030000', observed: '0.01', holds: false }]
        : [{ term: 'landed', expected: 'finalized and successful', observed: 'finalized, succeeded', holds: true }],
    note: `${verdict} for the test`,
  };
}

function fakeExchange(overrides: Record<string, unknown> = {}) {
  return {
    createJob: vi.fn(async () => ({ status: 'awaiting_payment', payment_intent: CREATE_INTENT })),
    paymentIntent: vi.fn(async () => HTTP_INTENT),
    submitPayment: vi.fn(async () => COMPLETED),
    job: vi.fn(async () => COMPLETED),
    getReceipt: vi.fn(async () => RECORDED.receipt),
    ...overrides,
  } as never;
}

const noWait = { sleep: async () => {}, pollMs: 1, waitMs: 3 };

beforeEach(() => {
  provePayment.mockReset();
  payDemand.mockReset();
});

describe('reading an intent', () => {
  it('reads both spellings the exchange has used', () => {
    const fromCreate = termsFromIntent(CREATE_INTENT);
    const fromHttp = termsFromIntent(HTTP_INTENT);

    for (const terms of [fromCreate, fromHttp]) {
      expect(terms).toMatchObject({
        jobId: JOB_ID,
        to: '2BJ4ezxqV9YJXc38D9duKBkdn4su4jE1beKUHwH663sL',
        tokenAccount: '5RyKShQxSkbUJ9vA2MZ1Qf2TKgnwhhS3m7mj2ZZaVh6t',
        memo: `PDAOJOB:${JOB_ID}`,
        expiresAt: '2026-09-23T13:38:50.376Z',
      });
    }
  });

  it('refuses an intent that names no payee rather than inventing one', () => {
    expect(() => termsFromIntent({ jobId: JOB_ID, amount: '1' })).toThrow(/payee/);
  });
});

describe('quoting', () => {
  it('checks the demand and builds for the payer, carrying the memo and the exact account', async () => {
    payDemand.mockResolvedValue({ report: { verdict: 'payable' }, transaction: { payload: {} } });

    const quote = await quoteJob(fakeExchange(), { service: 'token.intelligence', input: INPUT, from: PAYER });

    expect(quote.kind).toBe('payable');
    expect(payDemand).toHaveBeenCalledWith(
      expect.objectContaining({
        from: PAYER,
        to: '2BJ4ezxqV9YJXc38D9duKBkdn4su4jE1beKUHwH663sL',
        tokenAccount: '5RyKShQxSkbUJ9vA2MZ1Qf2TKgnwhhS3m7mj2ZZaVh6t',
        memo: `PDAOJOB:${JOB_ID}`,
        amountBaseUnits: '30000',
      }),
    );
  });

  it('lets a refused demand stop the quote, so nothing comes back to sign', async () => {
    payDemand.mockRejectedValue(new Error('DEMAND_REFUSED'));
    await expect(
      quoteJob(fakeExchange(), { service: 'token.intelligence', input: INPUT, from: PAYER }),
    ).rejects.toThrow(/DEMAND_REFUSED/);
  });

  it('returns a free job without building anything', async () => {
    const exchange = fakeExchange({ createJob: vi.fn(async () => ({ job_id: 'job_free', status: 'completed' })) });

    const quote = await quoteJob(exchange, { service: 'verify.basic', input: INPUT, from: PAYER });

    expect(quote.kind).toBe('free');
    expect(payDemand).not.toHaveBeenCalled();
  });
});

describe('settling', () => {
  it('proves, submits, and verifies the receipt against the input sent', async () => {
    provePayment.mockResolvedValue(proof('proven'));
    const exchange = fakeExchange();

    const settlement = await settleJob(exchange, { jobId: JOB_ID, signature: SIGNATURE, input: INPUT, ...noWait });

    expect(settlement.verdict).toBe('verified');
    expect(settlement.receiptCheck?.holds).toBe(true);
    expect((exchange as any).submitPayment).toHaveBeenCalledWith(JOB_ID, SIGNATURE);
  });

  it('holds the payment to the demand the exchange holds now, not a remembered one', async () => {
    provePayment.mockResolvedValue(proof('proven'));

    await settleJob(fakeExchange(), { jobId: JOB_ID, signature: SIGNATURE, input: INPUT, ...noWait });

    expect(provePayment).toHaveBeenCalledWith({
      signature: SIGNATURE,
      to: '2BJ4ezxqV9YJXc38D9duKBkdn4su4jE1beKUHwH663sL',
      amount: '0.030000',
      mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      tokenAccount: '5RyKShQxSkbUJ9vA2MZ1Qf2TKgnwhhS3m7mj2ZZaVh6t',
      memo: `PDAOJOB:${JOB_ID}`,
      expiresAt: '2026-09-23T13:38:50.376Z',
    });
  });

  it('never submits a payment that contradicts the demand', async () => {
    provePayment.mockResolvedValue(proof('contradicted'));
    const exchange = fakeExchange();

    const settlement = await settleJob(exchange, { jobId: JOB_ID, signature: SIGNATURE, ...noWait });

    expect(settlement.verdict).toBe('refused');
    expect(settlement.note).toMatch(/amount/);
    expect((exchange as any).submitPayment).not.toHaveBeenCalled();
  });

  it('waits for finality before submitting, and submits once it arrives', async () => {
    provePayment.mockResolvedValueOnce(proof('unproven')).mockResolvedValue(proof('proven'));
    const exchange = fakeExchange();

    const settlement = await settleJob(exchange, { jobId: JOB_ID, signature: SIGNATURE, input: INPUT, ...noWait });

    expect(provePayment).toHaveBeenCalledTimes(2);
    expect(settlement.verdict).toBe('verified');
  });

  it('gives up without submitting when finality never comes', async () => {
    provePayment.mockResolvedValue(proof('unproven'));
    const exchange = fakeExchange();

    const settlement = await settleJob(exchange, { jobId: JOB_ID, signature: SIGNATURE, ...noWait });

    expect(settlement.verdict).toBe('unproven');
    expect((exchange as any).submitPayment).not.toHaveBeenCalled();
  });

  it('polls a job still running after payment, then fetches its receipt by id', async () => {
    provePayment.mockResolvedValue(proof('proven'));
    const { receipt: _, ...bare } = COMPLETED;
    const exchange = fakeExchange({
      submitPayment: vi.fn(async () => ({ job_id: JOB_ID, status: 'running' })),
      job: vi.fn(async () => ({ ...bare, receipt_id: RECORDED.receipt['receipt_id'] })),
    });

    const settlement = await settleJob(exchange, { jobId: JOB_ID, signature: SIGNATURE, input: INPUT, ...noWait });

    expect((exchange as any).getReceipt).toHaveBeenCalledWith(RECORDED.receipt['receipt_id']);
    expect(settlement.verdict).toBe('verified');
  });

  it('reports pending, with the proof, when the job does not finish in time', async () => {
    provePayment.mockResolvedValue(proof('proven'));
    const running = vi.fn(async () => ({ job_id: JOB_ID, status: 'running' }));
    const exchange = fakeExchange({ submitPayment: running, job: running });

    const settlement = await settleJob(exchange, { jobId: JOB_ID, signature: SIGNATURE, ...noWait });

    expect(settlement.verdict).toBe('pending');
    expect(settlement.proof.verdict).toBe('proven');
  });

  it('keeps a failed job apart from a credited one', async () => {
    provePayment.mockResolvedValue(proof('proven'));
    const exchange = fakeExchange({ submitPayment: vi.fn(async () => ({ job_id: JOB_ID, status: 'failed' })) });

    const settlement = await settleJob(exchange, { jobId: JOB_ID, signature: SIGNATURE, ...noWait });

    expect(settlement.verdict).toBe('failed');
  });

  it('calls it credited, not verified, when there is no input to check the receipt against', async () => {
    provePayment.mockResolvedValue(proof('proven'));

    const settlement = await settleJob(fakeExchange(), { jobId: JOB_ID, signature: SIGNATURE, ...noWait });

    expect(settlement.verdict).toBe('credited');
    expect(settlement.note).toMatch(/pass the same input/);
  });

  it('does not verify a receipt that names a different payment', async () => {
    provePayment.mockResolvedValue(proof('proven'));
    const other = { ...COMPLETED, receipt: { ...RECORDED.receipt, payment_signature: 'someoneElse' } };
    const exchange = fakeExchange({ submitPayment: vi.fn(async () => other) });

    const settlement = await settleJob(exchange, { jobId: JOB_ID, signature: SIGNATURE, input: INPUT, ...noWait });

    expect(settlement.verdict).toBe('credited');
    expect(settlement.note).toMatch(/names payment someoneElse/);
  });
});
