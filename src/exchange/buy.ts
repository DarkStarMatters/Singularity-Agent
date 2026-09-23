/**
 * Buying a job on the PrivateDAO exchange, in the two halves that fit either
 * side of a signature.
 *
 * The first successful purchase took a hand-written script, a second HTTP call
 * the MCP tool pointed at without making, and a sixty-second signing window
 * crossed by pasting base64 between two shells. Every step in it already
 * existed here; what was missing was the order, and the checks between them.
 *
 * The split is the one rule this project does not bend. {@link quoteJob} goes as
 * far as an unsigned transaction and stops. Whatever signs it — a wallet, a
 * hardware key, a script on the payer's own machine — is outside this package,
 * and {@link settleJob} picks up from the signature it produces.
 *
 * ## What settling checks, and in what order
 *
 * 1. **The payment, from the chain**, before the exchange hears about it.
 *    `prove_payment` holds the transaction to the demand the exchange issued. A
 *    payment that contradicts it is not submitted — it is not this job's
 *    payment, and telling the exchange otherwise helps nobody. One that has not
 *    finalized yet is waited for, because the exchange accepts only finalized
 *    signatures and says so.
 * 2. **The credit**, by submitting and then polling until the job completes.
 * 3. **The receipt**, re-derived: its hashes must be the hashes of the input
 *    sent and the result returned.
 *
 * Landed, credited and verified are three different facts, and a September
 * payment that landed perfectly and was never credited is why they are kept
 * apart in the result.
 */

import { SingularityError } from '../core/errors.js';
import type { SimulationOutcome } from '../core/simulation.js';
import type { UnsignedTx } from '../core/types.js';
import type { PaymentDemandReport, PaymentProof } from '../pay/types.js';
import { payDemand, provePayment } from '../tools/operations.js';
import { checkReceipt, type Exchange, type ReceiptCheck } from './privatedao.js';

/** A payment intent's terms, in the shape `inspect_payment` and `prove_payment` read. */
export interface IntentTerms {
  jobId: string;
  to: string;
  tokenAccount?: string;
  mint?: string;
  asset?: string;
  amount: string;
  amountBaseUnits?: string;
  decimals?: number;
  memo?: string;
  expiresAt?: string;
}

/**
 * Read an intent into the terms the checks take.
 *
 * The exchange has spelled the same field more than one way across releases —
 * `expiresAt` and `expiresAtUtc`, `recipient` and `treasuryOwner` — so each is
 * read by every name it has been seen under. A field that is missing stays
 * missing: inventing a default here would be checking a demand nobody made.
 */
export function termsFromIntent(intent: Record<string, unknown>): IntentTerms {
  const text = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      const value = intent[key];
      if (typeof value === 'string' && value) return value;
    }
    return undefined;
  };

  const jobId = text('jobId', 'job_id');
  const to = text('treasuryOwner', 'recipient');
  const amount = text('amount');

  if (!jobId || !to || !amount) {
    throw new SingularityError(
      'DEMAND_INCOMPLETE',
      'That payment intent does not name a job, a payee and an amount, so there is nothing to check a payment against.',
      `It carried: ${Object.keys(intent).join(', ') || 'nothing'}.`,
    );
  }

  const tokenAccount = text('treasuryTokenAccount', 'tokenAccount');
  const mint = text('mint');
  const asset = text('asset');
  const amountBaseUnits = text('amountBaseUnits');
  const memo = text('paymentReference', 'memo');
  const expiresAt = text('expiresAtUtc', 'expiresAt');
  const decimals = typeof intent['decimals'] === 'number' ? intent['decimals'] : undefined;

  return {
    jobId,
    to,
    amount,
    ...(tokenAccount ? { tokenAccount } : {}),
    ...(mint ? { mint } : {}),
    ...(asset ? { asset } : {}),
    ...(amountBaseUnits ? { amountBaseUnits } : {}),
    ...(decimals !== undefined ? { decimals } : {}),
    ...(memo ? { memo } : {}),
    ...(expiresAt ? { expiresAt } : {}),
  };
}

export type Quote =
  | {
      kind: 'free';
      jobId?: string;
      /** The job as the exchange returned it: a free service answers at once. */
      job: Record<string, unknown>;
    }
  | {
      kind: 'payable';
      jobId: string;
      terms: IntentTerms;
      report: PaymentDemandReport;
      transaction: UnsignedTx;
      simulation?: SimulationOutcome;
    };

/**
 * Open a job, and — if it costs anything — check the demand and build the
 * unsigned payment for it.
 *
 * Refuses rather than builds when the demand does not check out, the same way
 * `build_payment` does: nothing comes back to sign for a demand that is wrong.
 */
export async function quoteJob(
  exchange: Exchange,
  options: { service: string; input?: Record<string, unknown>; from: string },
): Promise<Quote> {
  const created = await exchange.createJob(options.service, options.input ?? {});
  const intent = created['payment_intent'];

  if (!intent || typeof intent !== 'object') {
    const jobId = typeof created['job_id'] === 'string' ? created['job_id'] : undefined;
    return { kind: 'free', ...(jobId ? { jobId } : {}), job: created };
  }

  const terms = termsFromIntent(intent as Record<string, unknown>);
  const { jobId, ...demand } = terms;
  const { report, transaction, simulation } = await payDemand({ ...demand, from: options.from });

  return {
    kind: 'payable',
    jobId,
    terms,
    report,
    transaction,
    ...(simulation ? { simulation } : {}),
  };
}

/**
 * - `verified` — paid, credited, and the receipt re-derives from what was sent
 *   and returned.
 * - `credited` — paid and credited, but the receipt could not be re-derived:
 *   no input was given to check it against, or its hashes do not match.
 * - `pending` — paid and submitted, and the job has not completed yet.
 * - `failed` — paid, proven and submitted, and the exchange reports the job
 *   failed. The proof is the thing to take back to it.
 * - `refused` — the payment does not meet the demand, so it was never submitted.
 * - `unproven` — the chain could not settle the payment yet, so it was not
 *   submitted either. Retrying later is the right move.
 */
export type SettlementVerdict = 'verified' | 'credited' | 'pending' | 'failed' | 'refused' | 'unproven';

export interface Settlement {
  verdict: SettlementVerdict;
  jobId: string;
  signature: string;
  proof: PaymentProof;
  /** The job after submission, and after polling where it was still running. */
  job?: Record<string, unknown>;
  receipt?: Record<string, unknown>;
  receiptCheck?: ReceiptCheck;
  note: string;
}

export interface SettleOptions {
  jobId: string;
  signature: string;
  /** The input sent to `quoteJob`, so the receipt's input hash can be re-derived. */
  input?: Record<string, unknown>;
  /** How long to wait for the payment to finalize, and then for the job to finish. Default 90s each. */
  waitMs?: number;
  /** Between polls. Default 3s. */
  pollMs?: number;
  /** Injected so tests do not wait in real time. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Prove the payment, submit it, wait for the credit, and check the receipt.
 */
export async function settleJob(exchange: Exchange, options: SettleOptions): Promise<Settlement> {
  const { jobId, signature } = options;
  const waitMs = options.waitMs ?? 90_000;
  const pollMs = options.pollMs ?? 3_000;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));

  // Re-read rather than remembered: the demand the exchange holds now is the one
  // the payment will be judged against when it is submitted.
  const terms = termsFromIntent(await exchange.paymentIntent(jobId));
  const claim = {
    to: terms.to,
    amount: terms.amount,
    ...(terms.mint ? { mint: terms.mint } : {}),
    ...(terms.tokenAccount ? { tokenAccount: terms.tokenAccount } : {}),
    ...(terms.memo ? { memo: terms.memo } : {}),
    ...(terms.expiresAt ? { expiresAt: terms.expiresAt } : {}),
  };

  let proof = await provePayment({ signature, ...claim });
  for (let waited = 0; proof.verdict === 'unproven' && waited < waitMs; waited += pollMs) {
    await sleep(pollMs);
    proof = await provePayment({ signature, ...claim });
  }

  if (proof.verdict === 'contradicted') {
    return {
      verdict: 'refused',
      jobId,
      signature,
      proof,
      note: `Not submitted. This payment does not meet the demand for ${jobId} on: ${failedTerms(proof)}. Submitting it would ask the exchange to credit a payment that is not this job's.`,
    };
  }

  if (proof.verdict === 'unproven') {
    return {
      verdict: 'unproven',
      jobId,
      signature,
      proof,
      note: `Not submitted yet. ${proof.note} The exchange accepts only finalized payments; settle again once it has finalized.`,
    };
  }

  let job = await exchange.submitPayment(jobId, signature);
  for (let waited = 0; !isDone(job) && waited < waitMs; waited += pollMs) {
    await sleep(pollMs);
    job = await exchange.job(jobId);
  }

  if (!isDone(job)) {
    return {
      verdict: 'pending',
      jobId,
      signature,
      proof,
      job,
      note: `Paid and submitted, and the payment is proven on chain. The job was still ${String(job['status'] ?? 'unreported')} after ${Math.round(waitMs / 1000)}s — settle again to keep waiting. The proof above is yours to show either way.`,
    };
  }

  if (job['status'] === 'failed') {
    return {
      verdict: 'failed',
      jobId,
      signature,
      proof,
      job,
      note: `Paid, and the payment is proven on chain, but the exchange reports ${jobId} as failed. The proof above is the evidence to take to the exchange.`,
    };
  }

  // The payment endpoint returns the receipt inline; a polled job carries only
  // its id, so fetch it.
  let receipt = asRecord(job['receipt']);
  const receiptId = typeof job['receipt_id'] === 'string' ? job['receipt_id'] : receipt?.['receipt_id'];
  if (!receipt && typeof receiptId === 'string') receipt = await exchange.getReceipt(receiptId);

  const receiptCheck =
    receipt && options.input ? checkReceipt({ result: job['result'], receipt }, options.input) : undefined;
  const signed = receipt?.['payment_signature'];
  const bound = signed === undefined || signed === signature;

  const verified = Boolean(receiptCheck?.holds) && bound;

  return {
    verdict: verified ? 'verified' : 'credited',
    jobId,
    signature,
    proof,
    job,
    ...(receipt ? { receipt } : {}),
    ...(receiptCheck ? { receiptCheck } : {}),
    note: verified
      ? 'Paid, credited, and verified: the payment meets the demand on chain, and the receipt commits to exactly the input sent and the result returned.'
      : !bound
        ? `Credited, but the receipt names payment ${String(signed)}, not this one. Ask the exchange which payment it credited.`
        : !receipt
          ? 'Credited, but the exchange returned no receipt to check.'
          : !options.input
            ? 'Credited. The receipt was not re-derived, because no input was given to check its input hash against — pass the same input the job was created with.'
            : `Credited, but the receipt does not re-derive. ${receiptCheck?.note ?? ''}`.trim(),
  };
}

function isDone(job: Record<string, unknown>): boolean {
  return job['status'] === 'completed' || job['status'] === 'failed';
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function failedTerms(proof: PaymentProof): string {
  return proof.checks
    .filter((check) => check.holds === false)
    .map((check) => check.term)
    .join(', ');
}
