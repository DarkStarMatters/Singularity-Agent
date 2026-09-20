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
  /** What the wallet shows as the payee, on a transfer request. */
  label?: string;
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
 * The `solana:` URL a wallet opens — a Solana Pay **transfer request**.
 *
 * This replaced a transaction request pointing at `/api/pay`, and the reason is
 * that a payment never needed one. Solana Pay has two halves:
 *
 * - A **transaction request** is a link to an endpoint that builds the
 *   transaction. It exists for things a wallet cannot construct from a URL —
 *   a burn, a swap, anything multi-instruction. `/burn` needs this.
 * - A **transfer request** names the recipient, the amount and the token
 *   directly, and the wallet builds the transfer itself.
 *
 * A payment is a transfer, so the wallet can build it, and every reason to
 * prefer this follows from that: no endpoint has to be reachable, no server has
 * to be up, the link is far shorter — which matters when it has to fit in a
 * scannable QR — and it is the half of the spec every wallet implements.
 * Phantom's own payment documentation uses it.
 *
 * Settlement is unaffected, which is the part that could have gone wrong. The
 * spec requires the wallet to attach each `reference` as a read-only,
 * non-signer key on the transfer instruction — exactly the account
 * `findPayment` searches by, and exactly what the endpoint used to attach by
 * hand.
 *
 * The trade-off worth naming: a transfer request is self-contained, so it
 * cannot be expired or revoked after it leaves. The stored intent still holds
 * the merchant's own expiry and settle-once ledger, but a link that has escaped
 * will keep working until the recipient stops accepting it. A transaction
 * request can refuse at fetch time, which is the one thing it is still better
 * at.
 */
export function transferLink(params: PaymentRequestParams): string {
  // Built by hand rather than with URLSearchParams, which encodes a space as
  // `+`. That is correct for form submission and wrong here: the spec asks for
  // percent-encoded UTF-8, and a label reading "Order+7" in a wallet is the
  // kind of thing nobody notices until a customer does.
  const query: string[] = [`amount=${params.amount}`];

  if (params.mint) query.push(`spl-token=${params.mint}`);
  if (params.reference) query.push(`reference=${params.reference}`);
  if (params.label) query.push(`label=${encodeURIComponent(params.label)}`);
  if (params.memo) query.push(`memo=${encodeURIComponent(params.memo)}`);

  // The recipient follows the scheme directly, unencoded — it is base58, which
  // has no characters needing it.
  return `solana:${params.to}?${query.join('&')}`;
}

/**
 * The transaction-request form, pointing at a deployed `/api/pay`.
 *
 * Kept because it can do the one thing a transfer request cannot: refuse. The
 * endpoint sees every fetch, so it can decline an expired or already-paid
 * request before a wallet ever shows an approval screen. Costs a reachable
 * server and a much longer link.
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
