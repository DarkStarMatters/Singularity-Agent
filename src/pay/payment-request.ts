/**
 * A payment somebody can approve in their wallet, served from a static host.
 *
 * This is the deployable half of Pay, and it exists because the stored-intent
 * design does not survive contact with serverless. `FileIntentStore` is fine in
 * a CLI or a long-running bot; on Vercel there is no filesystem worth writing
 * to and no state between invocations, so an endpoint that resolves an opaque
 * id has nothing to resolve it *from*. That was worth discovering before
 * writing the route rather than after deploying it.
 *
 * So the wire format here is the burn endpoint's, for the same reasons: the
 * request carries its own parameters, and the endpoint is guarded by an
 * allowlist of **recipients** exactly as `allowedMints()` guards burns.
 *
 * The allowlist is what makes parameters safe. The objection to putting a
 * payment in a URL is that anybody can craft one — but with a fixed set of
 * destinations, the worst a stranger can build is a link that pays *you*.
 * Changing the amount changes what the payer is shown and approves; changing
 * the recipient is refused. What the allowlist removes is the case that made
 * this dangerous in the first place: an endpoint that will build a payment to
 * an address the asker chose, under a domain your customers have learned to
 * trust.
 *
 * Intents are not gone. They keep the merchant's own record — order binding,
 * expiry, the mint risk read at creation, and the settle-exactly-once ledger —
 * on the side where durable state actually exists. What travels to the wallet
 * is this.
 */

import { buildPayment } from '../adapters/solana.js';
import { getChain } from '../core/registry.js';
import { SingularityError } from '../core/errors.js';
import { allowedRecipients } from './file-store.js';

/** The longest memo this will carry into a transaction. */
const MAX_MEMO_LENGTH = 200;

export interface PaymentRequestParams {
  /** Who gets paid. Must be one of {@link allowedRecipients}. */
  to: string;
  /** Whole tokens as a decimal string, never base units. */
  amount: string;
  /** Mint address. Absent means native SOL. */
  mint?: string;
  /**
   * The pubkey that makes this payment findable on chain.
   *
   * Optional here and supplied by whoever created the request, because only
   * they need to correlate it. A link with no reference still pays; it just
   * cannot be matched to an order automatically.
   */
  reference?: string;
  memo?: string;
  chain?: string;
}

/**
 * Read and check the parameters a link carries.
 *
 * Short names on purpose. A QR's size is set by its byte count, and two base58
 * addresses plus a reference is already most of a version-9 code — `to=` versus
 * `t=` is the difference between a code that fits and one that does not.
 */
export function parsePaymentRequest(
  query: Record<string, string | undefined>,
): PaymentRequestParams {
  const to = (query.t ?? query.to)?.trim();
  const amount = (query.a ?? query.amount)?.trim();
  const mint = (query.m ?? query.mint)?.trim();
  const reference = (query.r ?? query.ref ?? query.reference)?.trim();
  const memo = (query.o ?? query.memo)?.trim();

  if (!to || !amount) {
    throw new SingularityError(
      'BAD_REQUEST',
      'A payment link needs both a recipient and an amount.',
      'Those are the two things a wallet cannot supply for you.',
    );
  }

  const allowed = allowedRecipients();

  if (allowed.length === 0) {
    throw new SingularityError(
      'NO_PAY_RECIPIENTS',
      'This endpoint has no configured recipients, so it will not build a payment.',
      'Set SINGULARITY_PAY_RECIPIENTS on the deployment. Unset is deliberately "nobody" rather than "anyone": an endpoint that builds a payment to whatever address it is handed is a phishing primitive wearing this deployment\'s domain.',
    );
  }

  if (!allowed.includes(to)) {
    throw new SingularityError(
      'RECIPIENT_NOT_ALLOWED',
      `This endpoint does not build payments to ${to}.`,
      'It serves a named set of recipients on purpose, which is what makes a link carrying its own parameters safe to publish at all.',
    );
  }

  if (!/^\d+(\.\d+)?$/.test(amount)) {
    throw new SingularityError(
      'BAD_REQUEST',
      `"${amount}" is not an amount.`,
      'Amounts are whole tokens as a decimal string, never base units.',
    );
  }

  if (Number(amount) === 0) {
    throw new SingularityError(
      'BAD_REQUEST',
      'A payment request for zero is not a payment.',
      'Pass an amount greater than zero.',
    );
  }

  return {
    to,
    amount,
    ...(mint ? { mint } : {}),
    ...(reference ? { reference } : {}),
    ...(memo ? { memo: memo.slice(0, MAX_MEMO_LENGTH) } : {}),
    ...(query.c || query.chain ? { chain: (query.c ?? query.chain)!.trim() } : {}),
  };
}

/**
 * The `solana:` URL a wallet opens.
 *
 * The inner https URL is percent-encoded whole, because it carries its own
 * query string and a wallet splitting on the first `?` would otherwise lose
 * everything after it — the same reason the burn link does it.
 */
export function paymentLink(endpoint: string, params: PaymentRequestParams): string {
  const url = new URL(endpoint);
  url.searchParams.set('t', params.to);
  url.searchParams.set('a', params.amount);
  if (params.mint) url.searchParams.set('m', params.mint);
  if (params.reference) url.searchParams.set('r', params.reference);
  if (params.memo) url.searchParams.set('o', params.memo);
  if (params.chain) url.searchParams.set('c', params.chain);

  return `solana:${encodeURIComponent(url.toString())}`;
}

/**
 * What the wallet shows before it asks anyone to approve anything.
 *
 * The icon is served from the endpoint's own origin on purpose. A wallet
 * displays that domain as the thing being trusted, and an icon fetched from
 * anywhere else is the one element of that screen which did not come from where
 * it claims to.
 */
export function describePaymentRequest(params: PaymentRequestParams): {
  label: string;
  icon: string;
} {
  return {
    label: `Pay ${params.amount}`,
    icon:
      process.env.SINGULARITY_PAY_ICON ||
      'https://singularity-agent.cicada71.net/assets/icon-64.png',
  };
}

/**
 * Build the payment for the account the wallet sends.
 *
 * The account arrives in the POST body rather than in the link, which is the
 * quiet improvement: nobody has to know, type or paste their own address. The
 * wallet knows it.
 *
 * `message` is what the wallet displays alongside the decoded transaction. It
 * names the recipient by address and never by any label chosen for them,
 * because it is the last thing read before a signature.
 */
export async function buildPaymentRequest(
  account: string,
  params: PaymentRequestParams,
): Promise<{ transaction: string; message: string }> {
  const chain = getChain(params.chain ?? 'solana');

  if (chain.family !== 'svm') {
    throw new SingularityError(
      'PAY_UNSUPPORTED',
      `Singularity Pay is built on Solana Pay, and ${chain.name} is not a Solana chain.`,
      'The transaction-request protocol this depends on is Solana-specific.',
    );
  }

  const built = await buildPayment(chain, {
    payer: account,
    to: params.to,
    amount: params.amount,
    ...(params.mint ? { mint: params.mint } : {}),
    ...(params.memo ? { memo: params.memo } : {}),
    ...(params.reference ? { references: [params.reference] } : {}),
  });

  const asset = params.mint ? `of mint ${params.mint}` : 'SOL';
  const message =
    `Pay ${params.amount} ${asset} to ${params.to}.` +
    (params.memo ? ` Carries the memo "${params.memo}", which is what credits this payment to your order.` : '');

  return { transaction: built.payload.transaction as string, message };
}
