/**
 * The four things a payment rail actually has to do.
 *
 * Create an intent, answer a wallet asking about one, build the transaction for
 * the account that wallet sends, and decide — later, separately, and
 * conservatively — whether the merchant has been paid.
 *
 * The fourth is the one worth reading. Every other rail collapses it into a
 * boolean and every one of them is wrong in the same three ways: it does not
 * distinguish confirmed from finalized, it does not check that the money went
 * to the right place in the right token for the right amount, and it does not
 * tell you whether what you just received can be taken back. See `types.ts`.
 */

import { buildPayment, findPayment, assessMintRisk } from '../adapters/solana.js';
import { getChain } from '../core/registry.js';
import { SingularityError } from '../core/errors.js';
import {
  isExpired,
  prepareIntent,
  type CreateIntentParams,
  type IntentStore,
  type StoredIntent,
} from './intent.js';
import {
  meetsSettlement,
  type MintRisk,
  type PaymentSettlement,
  type SettlementLevel,
} from './types.js';
import type { UnsignedTx } from '../core/types.js';
import { transferLink } from './payment-request.js';

/** Solana only, and said out loud rather than assumed. */
function solanaChain(chainRef: string | undefined): ReturnType<typeof getChain> {
  const chain = getChain(chainRef ?? 'solana');
  if (chain.family !== 'svm') {
    throw new SingularityError(
      'PAY_UNSUPPORTED',
      `Singularity Pay is built on Solana Pay, and ${chain.name} is not a Solana chain.`,
      'The transaction-request protocol this depends on is Solana-specific. EVM has no equivalent with a settlement-correlation mechanism, so there is nothing to port rather than reinvent.',
    );
  }
  return chain;
}

export interface CreatedIntent {
  intent: StoredIntent;
  /** The `solana:` URL to put in a QR code or a link. */
  url: string;
  /** What the merchant is exposed to by accepting this token. */
  risk?: MintRisk;
}

/**
 * Create an intent, and read the mint before agreeing to accept it.
 *
 * The risk read is not decoration and it is not optional. A merchant about to
 * accept an SPL token needs to know, *before* they publish the link, whether
 * the issuer can freeze the account it lands in or pull it back out afterwards.
 * That answer does not change between creation and settlement, so it is read
 * once, here, and stored with the intent — which also means it is in the record
 * when somebody later asks why a payment was accepted.
 *
 * It does not refuse on its own. Plenty of legitimate tokens carry a freeze
 * authority, and whether that is acceptable is a commercial decision, not a
 * library's. `risk.custodyIsYours` is the bit to branch on.
 */
export async function createIntent(
  store: IntentStore,
  endpoint: string,
  params: CreateIntentParams,
): Promise<CreatedIntent> {
  const chain = solanaChain(params.chain);
  const prepared = prepareIntent({ ...params, chain: chain.id });

  const risk = prepared.mint ? await assessMintRisk(chain, prepared.mint) : undefined;

  const intent: StoredIntent = { ...prepared, ...(risk ? { risk } : {}) };
  await store.put(intent);

  // A transfer request, not a transaction request. Phantom rejected the latter
  // and it was the wrong half of the spec regardless: a payment is a transfer,
  // so the wallet can build it, and nothing here has to be reachable for a
  // customer to pay. See `transferLink` for the full reasoning and the one
  // thing the endpoint form is still better at.
  //
  // `endpoint` is now unused by this path and kept in the signature because a
  // deployment that wants fetch-time refusal can still point at `/api/pay`.
  void endpoint;

  return {
    intent,
    url: transferLink({
      to: intent.to,
      amount: intent.amount,
      ...(intent.mint ? { mint: intent.mint } : {}),
      reference: intent.reference,
      label: intent.label,
      ...(intent.memo ? { memo: intent.memo } : {}),
    }),
    ...(risk ? { risk } : {}),
  };
}

/** Fetch an intent for presentation, refusing the ones that should not be. */
export async function resolveIntent(store: IntentStore, id: string): Promise<StoredIntent> {
  const intent = await store.get(id);

  if (!intent) {
    // Deliberately the same answer for "never existed" and "expired and was
    // swept". An endpoint that distinguishes them lets somebody enumerate
    // which ids were ever real.
    throw new SingularityError(
      'INTENT_NOT_FOUND',
      'No payment request with that id.',
      'The link may be mistyped, expired, or already cleared.',
    );
  }

  if (isExpired(intent)) {
    throw new SingularityError(
      'INTENT_EXPIRED',
      'This payment request has expired.',
      'Ask the merchant for a new link. The old one cannot be revived, and paying against it would leave the payment uncredited.',
    );
  }

  if (intent.settledAt) {
    throw new SingularityError(
      'INTENT_ALREADY_PAID',
      'This payment request has already been paid.',
      'Paying it again would send money nobody is expecting. If you believe this is wrong, contact the merchant with the order reference rather than paying twice.',
    );
  }

  return intent;
}

/**
 * What the wallet shows before it asks anyone to approve anything.
 *
 * The icon comes from the endpoint's own origin for the reason the burn flow
 * already gives: a wallet displays the endpoint's domain as the thing being
 * trusted, and an icon fetched from anywhere else is the one element of that
 * screen that did not come from where it claims to.
 */
export function describeIntent(intent: StoredIntent, icon?: string): { label: string; icon: string } {
  return {
    label: intent.label,
    icon: icon || process.env.SINGULARITY_PAY_ICON || 'https://singularity-agent.cicada71.net/assets/icon-64.png',
  };
}

/**
 * Build the payment for the account the wallet sends.
 *
 * The account arrives in the POST body rather than the link, so nobody has to
 * know, type or paste their own address — the wallet knows it. Everything else
 * comes from the stored intent and none of it from the request, which is what
 * makes a forged or edited link inert.
 */
export async function buildIntentPayment(
  intent: StoredIntent,
  account: string,
): Promise<{ transaction: string; message: string }> {
  const chain = solanaChain(intent.chain);

  const built: UnsignedTx = await buildPayment(chain, {
    payer: account,
    to: intent.to,
    amount: intent.amount,
    ...(intent.mint ? { mint: intent.mint } : {}),
    ...(intent.memo ? { memo: intent.memo } : {}),
    references: [intent.reference],
  });

  // What the wallet displays next to the decoded transaction. It is the last
  // thing read before a signature, so it names the recipient by address and
  // never by any label the merchant chose for themselves.
  const asset = intent.mint ? `of mint ${intent.mint}` : 'SOL';
  const message =
    intent.message?.trim() ||
    `Pay ${intent.amount} ${asset} to ${intent.to}.` +
      (intent.memo ? ` Carries the memo "${intent.memo}", which is what credits this payment to your order.` : '');

  return { transaction: built.payload.transaction as string, message };
}

export interface SettlementResult extends PaymentSettlement {
  intent: StoredIntent;
  /**
   * Whether this call is the one that should trigger fulfilment.
   *
   * True exactly once per intent, ever. Distinct from `level === 'final'`,
   * which stays true on every subsequent call — a merchant polling in a loop
   * would otherwise ship the same order repeatedly, and that is the bug this
   * field exists to make impossible to write.
   */
  fulfil: boolean;
}

/**
 * Has this intent been paid, and is this the call that should act on it?
 *
 * Conservative on purpose, in three separate ways:
 *
 * - It requires `final` by default, not `confirmed`. A confirmed transaction
 *   can still be dropped, and the whole point of a settlement check is to stand
 *   between a merchant and shipping against something reversible. A caller who
 *   genuinely wants to reserve stock on a weaker signal can lower the bar
 *   explicitly, which is a decision they have then made in writing.
 * - It refuses on *any* mismatch. A finalized transaction to the wrong address,
 *   in the wrong mint, or for less than was asked is not a payment, and the
 *   `mismatches` array says which.
 * - It marks settled atomically and returns `fulfil: false` if something else
 *   already did. A reference is public the moment it lands, so the same
 *   payment can be presented twice.
 */
export async function settleIntent(
  store: IntentStore,
  id: string,
  options: { require?: SettlementLevel } = {},
): Promise<SettlementResult> {
  const required = options.require ?? 'final';
  const intent = await store.get(id);

  if (!intent) {
    throw new SingularityError(
      'INTENT_NOT_FOUND',
      'No payment request with that id.',
      'Settlement is checked against a stored intent; without one there is nothing to check against.',
    );
  }

  const chain = solanaChain(intent.chain);

  const settlement = await findPayment(chain, {
    to: intent.to,
    amount: intent.amount,
    ...(intent.mint ? { mint: intent.mint } : {}),
    ...(intent.memo ? { memo: intent.memo } : {}),
    reference: intent.reference,
  });

  // Already recorded as settled: report the payment, refuse to trigger again.
  if (intent.settledAt) {
    return {
      ...settlement,
      intent,
      fulfil: false,
      alreadyFulfilled: {
        at: intent.settledAt,
        ...(intent.orderId ? { purpose: intent.orderId } : {}),
      },
      note: `This payment was already fulfilled at ${intent.settledAt}. ${settlement.note}`,
    };
  }

  if (settlement.mismatches.length > 0 || !meetsSettlement(settlement.level, required)) {
    return { ...settlement, intent, fulfil: false };
  }

  // The claim holds and it is settled enough. Take the slot; whoever gets it
  // is the one call that fulfils.
  const won = await store.markSettled(intent.id, settlement.signature ?? '');

  return {
    ...settlement,
    intent,
    fulfil: won,
    ...(won
      ? {}
      : {
          alreadyFulfilled: { at: new Date().toISOString(), ...(intent.orderId ? { purpose: intent.orderId } : {}) },
          note: `Another caller fulfilled this payment first. ${settlement.note}`,
        }),
  };
}
