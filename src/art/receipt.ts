/**
 * A receipt, as metadata — and the one honest thing to say about where it lives.
 *
 * The art for a payment is derived from its reference, so a receipt NFT is not
 * a picture attached to a payment. It is a picture *of* one, and anybody with
 * the reference can regenerate it byte for byte and check it matches. That is
 * the property this file is built around, because the obvious alternative does
 * not work:
 *
 * **The image cannot be stored on chain.** Metaplex Token Metadata caps the
 * `uri` field at 200 characters. The smallest receipt this project renders is
 * about 30KB of SVG — 40KB once base64'd — so a `data:` URI misses the limit by
 * two orders of magnitude, and no amount of optimisation closes that. Any
 * claim that the image is "stored on chain" in a normal Metaplex mint is false.
 *
 * So the honest arrangement is the inverse. The *seed* goes on chain, where it
 * already is: the reference is an account key on the transfer instruction, and
 * it cannot be edited after the fact. The image is a function of it. A hosted
 * JSON can rot, be replaced, or serve a different picture to different callers
 * — and it will not matter, because {@link verifyReceiptImage} re-renders from
 * the reference and says whether what was served is what the payment actually
 * looks like. A mutable pointer you can independently check is a different
 * thing from a mutable pointer you have to trust.
 *
 * This project ships a tool that warns holders about mutable metadata. Minting
 * one that could not be checked would be poor form.
 */

import { qrMatrix } from '../core/qr.js';
import { renderQrArt, styleFor, type ArtStyle } from './qr-art.js';
import { transferLink } from '../pay/payment-request.js';
import type { StoredIntent } from '../pay/intent.js';
import type { PaymentSettlement, SettlementLevel } from '../pay/types.js';

/** The longest `uri` a Metaplex Token Metadata account will hold. */
export const METAPLEX_URI_LIMIT = 200;

/**
 * What a receipt is allowed to assert.
 *
 * Only facts that survived verification. A receipt is evidence, and evidence
 * assembled from a claim rather than from a settlement is a forgery with good
 * intentions — it would say "paid" because someone asked for money, not
 * because money arrived.
 */
export interface ReceiptFacts {
  reference: string;
  to: string;
  amount: string;
  mint?: string;
  label: string;
  orderId?: string;
  /** The transaction that paid. Present because an unsettled receipt is refused. */
  signature: string;
  /** ISO 8601, from the block time rather than from this machine's clock. */
  settledAt: string;
  level: SettlementLevel;
}

/**
 * Turn an intent and its settlement into the facts a receipt may state.
 *
 * Fail-closed, like `requireAllowedRecipient`. Three refusals, each for a way a
 * receipt could be true-looking and wrong:
 *
 * - **Not final.** A `probabilistic` payment is confirmed and still reversible.
 *   Minting against one produces a permanent token attesting to a transaction
 *   that can still be dropped — and the token does not get dropped with it.
 * - **Mismatches.** A payment can be final and not be *yours*: right chain,
 *   wrong mint, wrong amount, wrong recipient. `mismatches` is non-empty
 *   exactly then, and it is the field to read before `level`.
 * - **No signature.** Nothing to point at. A receipt that cannot name its
 *   transaction cannot be checked by the person holding it.
 */
export function receiptFacts(intent: StoredIntent, settlement: PaymentSettlement): ReceiptFacts {
  if (settlement.level !== 'final') {
    throw new Error(
      `Refusing to build a receipt for a payment that is "${settlement.level}" rather than final. ` +
        'Only a finalized transaction is irreversible, and a receipt outlives the transaction it describes.',
    );
  }

  if (settlement.mismatches.length > 0) {
    throw new Error(
      `Refusing to build a receipt for a payment that does not match the claim: ${settlement.mismatches.join('; ')}.`,
    );
  }

  if (!settlement.signature) {
    throw new Error('Refusing to build a receipt with no transaction signature to point at.');
  }

  return {
    reference: intent.reference,
    to: intent.to,
    amount: intent.amount,
    ...(intent.mint ? { mint: intent.mint } : {}),
    label: intent.label,
    ...(intent.orderId ? { orderId: intent.orderId } : {}),
    signature: settlement.signature,
    settledAt: settlement.at ?? intent.settledAt ?? new Date().toISOString(),
    level: settlement.level,
  };
}

/**
 * The receipt's image: the same code the payer scanned.
 *
 * Deliberately the payment QR rather than a new picture. The token then shows
 * the thing that was actually presented, and the link it encodes still resolves
 * to the transfer that settled — a receipt you can read with a camera.
 */
export function receiptImage(facts: ReceiptFacts, scale = 8): string {
  const link = transferLink({
    to: facts.to,
    amount: facts.amount,
    ...(facts.mint ? { mint: facts.mint } : {}),
    reference: facts.reference,
    label: facts.label,
  });

  return renderQrArt(qrMatrix(link), facts.reference, { scale });
}

/**
 * Re-derive a receipt's image and compare it to what was served.
 *
 * The check that makes a hosted image safe to use. Marketplaces will fetch the
 * JSON from wherever the `uri` points, and that host can change its mind; this
 * says whether the picture it returned is the one the payment generates. A
 * false here does not mean the payment is bad — it means the image is not
 * evidence of it.
 */
export function verifyReceiptImage(facts: ReceiptFacts, served: string, scale = 8): boolean {
  return receiptImage(facts, scale) === served;
}

/** A Metaplex-shaped attribute. */
interface Attribute {
  trait_type: string;
  value: string;
}

export interface ReceiptMetadataOptions {
  /**
   * Where the image will be served from.
   *
   * Required, and deliberately not defaulted: hosting is the application's
   * decision and its retention policy, the same call as `IntentStore`. A
   * library that silently picked a gateway would be a library that loses your
   * images when that gateway stops.
   */
  image: string;
  /** Overrides the style derived from the reference. For previews only. */
  style?: ArtStyle;
  /** On-chain symbol. Ten characters is the Metaplex limit. */
  symbol?: string;
  /** Where a holder can go to check the payment themselves. */
  explorerBase?: string;
}

/**
 * The off-chain JSON a marketplace reads.
 *
 * The attributes are chosen so the token is useful as proof rather than
 * decorative: reference and signature make it checkable, amount and recipient
 * make it legible, and the style traits are what a collector sorts on. The
 * reference is listed first because it is the one field from which everything
 * else about the picture can be recomputed.
 */
export function receiptMetadata(
  facts: ReceiptFacts,
  options: ReceiptMetadataOptions,
): Record<string, unknown> {
  const style = options.style ?? styleFor(facts.reference);
  const token = facts.mint ? facts.mint : 'SOL';
  const explorer = options.explorerBase ?? 'https://solscan.io/tx/';

  const attributes: Attribute[] = [
    { trait_type: 'Reference', value: facts.reference },
    { trait_type: 'Amount', value: facts.amount },
    { trait_type: 'Token', value: token },
    { trait_type: 'Recipient', value: facts.to },
    { trait_type: 'Settled', value: facts.settledAt.slice(0, 10) },
    { trait_type: 'Settlement', value: facts.level },
    { trait_type: 'Palette', value: style.palette.name },
    { trait_type: 'Modules', value: style.shape },
    { trait_type: 'Finders', value: style.finder },
  ];

  if (facts.orderId) attributes.push({ trait_type: 'Order', value: facts.orderId });

  return {
    name: receiptName(facts),
    symbol: (options.symbol ?? 'SNGLR').slice(0, 10),
    description:
      `Proof of a payment of ${facts.amount} ${facts.mint ? 'tokens' : 'SOL'} to ${facts.to}, ` +
      `finalized on Solana in transaction ${facts.signature}. ` +
      'The artwork is derived deterministically from the payment reference, so it can be ' +
      're-rendered from on-chain data and checked against this image.',
    image: options.image,
    external_url: `${explorer}${facts.signature}`,
    attributes,
    properties: {
      category: 'image',
      files: [{ uri: options.image, type: 'image/svg+xml' }],
    },
  };
}

/**
 * The on-chain name, within the 32-byte Metaplex limit.
 *
 * Truncated rather than rejected, because a name is cosmetic — the reference in
 * the attributes is what identifies the payment, and it is not abbreviated
 * anywhere.
 */
export function receiptName(facts: ReceiptFacts): string {
  return `Receipt ${facts.reference.slice(0, 8)}`.slice(0, 32);
}

/**
 * Whether a URI will fit in the on-chain metadata account.
 *
 * Worth calling before a mint rather than after: the transaction fails on a
 * long `uri`, and it fails after the mint account has been created and paid
 * for, which is a confusing way to lose rent.
 */
export function uriFits(uri: string): boolean {
  return Buffer.byteLength(uri, 'utf8') <= METAPLEX_URI_LIMIT;
}
