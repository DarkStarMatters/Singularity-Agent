/**
 * A payment intent, and why the link carries nothing but an id.
 *
 * The existing burn endpoint already states the danger this file is built
 * around, in `transaction-request.ts`:
 *
 * > A transaction request is a URL anybody can craft and send to anybody, and
 * > the wallet shows its origin — so an open burn endpoint is a phishing
 * > primitive wearing this project's domain, and the more the domain comes to
 * > be trusted the better it works.
 *
 * Burns close that with an allowlist of mints, because there are few of them
 * and they change rarely. **Payments cannot use that trick.** A merchant's
 * recipients and amounts are open-ended by definition, so the obvious design —
 * `?to=<address>&amount=<number>` — hands anybody a generator for
 * authentic-looking payment requests under a domain customers have learned to
 * trust. It would be the single worst thing this project could ship.
 *
 * So no payment detail travels in the URL. An intent is created server-side by
 * whoever owns the endpoint, stored, and addressed by an unguessable id:
 *
 *     solana:https://pay.example.com/i/8f3ac21e9d7b4c05…
 *
 * There is nothing in that link to tamper with. Changing a character produces
 * an id that does not resolve, not a payment to somewhere else. The endpoint
 * can only ever build what a merchant already authorised, which closes the
 * category structurally rather than by filtering.
 *
 * The id is also the reason intents are *stored* rather than signed. A
 * self-describing HMAC token would need no database, and could not be expired,
 * revoked, or marked paid — and settlement needs durable state regardless, so
 * the stateless version saves nothing and gives up the three things that
 * matter.
 */

import { randomBytes } from 'node:crypto';
import { Keypair } from '@solana/web3.js';
import { SingularityError } from '../core/errors.js';
import type { MintRisk } from './types.js';

/** How long an intent may be presented for, before it stops resolving. */
const DEFAULT_TTL_SECONDS = 900;

/**
 * The upper bound on a TTL, which exists because the blockhash inside a built
 * transaction expires in about a minute regardless. A long-lived intent does
 * not make a payment more likely to land; it makes a stale link more likely to
 * be sitting somewhere when circumstances have changed.
 */
const MAX_TTL_SECONDS = 24 * 60 * 60;

export interface CreateIntentParams {
  /** Who gets paid. An address, never a symbol or an alias. */
  to: string;
  /** Whole tokens as a decimal string, never base units. */
  amount: string;
  /** Mint address. Absent means native SOL. Never a ticker. */
  mint?: string;
  /** What the wallet shows as the payee. */
  label?: string;
  /** What the wallet shows as the reason. */
  message?: string;
  /** Text the payment must carry. Bound here, never supplied by the payer. */
  memo?: string;
  /** Seconds this intent remains presentable. Default 900, max 86400. */
  expiresIn?: number;
  /** The merchant's own order id, carried through settlement. Opaque here. */
  orderId?: string;
  chain?: string;
}

/**
 * An intent, as stored.
 *
 * `referenceSecret` is deliberately absent. The reference is a *public* key
 * used as a lookup handle; there is no private key to keep, because nothing
 * ever signs with it. Generating it from a keypair is simply the cheapest way
 * to get a valid, unguessable, curve-correct pubkey.
 */
export interface StoredIntent {
  id: string;
  reference: string;
  to: string;
  amount: string;
  mint?: string;
  label: string;
  message?: string;
  memo?: string;
  orderId?: string;
  chain: string;
  createdAt: string;
  expiresAt: string;
  /** What accepting this token exposes the merchant to, read at creation. */
  risk?: MintRisk;
  /** Set once a payment for this intent has been fulfilled. */
  settledAt?: string;
  settledSignature?: string;
}

/**
 * Where intents live between creation and settlement.
 *
 * A port, not an implementation — the same shape of decision as `Signer` in the
 * SDK. Durable state belongs to the application: its database, its retention
 * policy, its backup story. This package ships an in-memory version for tests
 * and nothing for production, because a library that quietly owns your payment
 * records is a library that loses them.
 *
 * `markSettled` returns false when the intent was already settled. That return
 * is the idempotency primitive the whole flow rests on — a reference is public
 * once the transaction lands, so the same payment can be presented twice and
 * the second presentation must not pay out again. Implementations must make it
 * atomic; the in-memory one is, and a JSON file on disk is not.
 */
export interface IntentStore {
  put(intent: StoredIntent): Promise<void>;
  get(id: string): Promise<StoredIntent | null>;
  /** By reference rather than id, for settlement arriving from the chain. */
  byReference(reference: string): Promise<StoredIntent | null>;
  /** Atomically mark settled. False means it already was. */
  markSettled(id: string, signature: string): Promise<boolean>;
}

/**
 * An in-memory store, for tests and single-process demos.
 *
 * Says what it is in its name so nobody deploys it by accident. It loses
 * everything on restart, which for a payment record is the worst available
 * failure: the money arrived and the order did not.
 */
export class InMemoryIntentStore implements IntentStore {
  private readonly byId = new Map<string, StoredIntent>();
  private readonly refs = new Map<string, string>();

  async put(intent: StoredIntent): Promise<void> {
    this.byId.set(intent.id, intent);
    this.refs.set(intent.reference, intent.id);
  }

  async get(id: string): Promise<StoredIntent | null> {
    return this.byId.get(id) ?? null;
  }

  async byReference(reference: string): Promise<StoredIntent | null> {
    const id = this.refs.get(reference);
    return id ? (this.byId.get(id) ?? null) : null;
  }

  async markSettled(id: string, signature: string): Promise<boolean> {
    const intent = this.byId.get(id);
    if (!intent || intent.settledAt) return false;
    // Single-threaded JS makes this atomic here. It is not atomic in any store
    // where two processes can read before either writes.
    this.byId.set(id, { ...intent, settledAt: new Date().toISOString(), settledSignature: signature });
    return true;
  }
}

/**
 * An id nobody can guess and nothing can be derived from.
 *
 * 128 bits of randomness, hex-encoded. Not a hash of the order, not a counter,
 * not anything that leaks how many payments a merchant has taken — the id is
 * the *only* thing protecting the intent, since it travels in a link that gets
 * pasted into chat apps and QR codes.
 */
export function newIntentId(): string {
  return randomBytes(16).toString('hex');
}

/**
 * A fresh reference pubkey.
 *
 * Solana Pay's correlation mechanism. The private half is discarded
 * immediately and deliberately: nothing signs with a reference, so keeping it
 * would be creating a secret with no purpose and a liability.
 */
export function newReference(): string {
  return Keypair.generate().publicKey.toBase58();
}

/** Validate and normalise what a merchant asked for. */
export function prepareIntent(params: CreateIntentParams): Omit<StoredIntent, 'risk'> {
  const to = params.to?.trim();
  const amount = params.amount?.trim();

  if (!to) {
    throw new SingularityError(
      'BAD_INTENT',
      'A payment intent needs a recipient.',
      'Pass `to` as an address. This is bound at creation and can never be supplied by the payer.',
    );
  }

  if (!amount || !/^\d+(\.\d+)?$/.test(amount)) {
    throw new SingularityError(
      'BAD_INTENT',
      `"${params.amount}" is not an amount.`,
      'Amounts are whole tokens as a decimal string, never base units.',
    );
  }

  if (Number(amount) === 0) {
    throw new SingularityError(
      'BAD_INTENT',
      'A payment intent for zero is not a payment.',
      'Pass an amount greater than zero.',
    );
  }

  const ttl = params.expiresIn ?? DEFAULT_TTL_SECONDS;
  if (!Number.isFinite(ttl) || ttl <= 0 || ttl > MAX_TTL_SECONDS) {
    throw new SingularityError(
      'BAD_INTENT',
      `${params.expiresIn} is not a usable lifetime, in seconds.`,
      `Between 1 and ${MAX_TTL_SECONDS}. The blockhash inside a built transaction expires in about a minute regardless, so a long-lived intent only means a stale link sitting somewhere.`,
    );
  }

  const now = new Date();

  return {
    id: newIntentId(),
    reference: newReference(),
    to,
    amount,
    ...(params.mint ? { mint: params.mint.trim() } : {}),
    label: params.label?.trim() || `Payment of ${amount}`,
    ...(params.message ? { message: params.message.trim() } : {}),
    ...(params.memo ? { memo: params.memo.trim().slice(0, 256) } : {}),
    ...(params.orderId ? { orderId: params.orderId } : {}),
    chain: params.chain ?? 'solana',
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttl * 1000).toISOString(),
  };
}

/** True when this intent may still be presented. */
export function isExpired(intent: StoredIntent, now = new Date()): boolean {
  return new Date(intent.expiresAt).getTime() <= now.getTime();
}

/**
 * The `solana:` URL a wallet opens.
 *
 * The inner https URL is percent-encoded whole, for the same reason the burn
 * link does it: a wallet splitting on the first `?` would otherwise lose
 * everything after it. Here there is no query string to lose — the id is a path
 * segment — but the encoding stays, because a wallet that mis-splits a URL with
 * no query is a wallet that will mis-split this one too.
 */
export function intentLink(endpoint: string, id: string): string {
  const base = endpoint.endsWith('/') ? endpoint : `${endpoint}/`;
  return `solana:${encodeURIComponent(new URL(id, base).toString())}`;
}
