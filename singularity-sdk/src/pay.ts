/**
 * Singularity Pay, as an application uses it.
 *
 * Four calls and a request handler. The shape is deliberately small because
 * the hard parts are not API surface — they are the three questions a payment
 * rail has to answer and almost none of them do:
 *
 * **Am I about to accept something that can be taken back?** `createIntent`
 * reads the mint before the link is ever published, and tells you whether a
 * freeze authority or a permanent delegate means the balance you are paid is
 * held at the issuer's discretion. That check runs once, at creation, and is
 * stored with the intent so the record survives the decision.
 *
 * **Is this actually my payment?** `settle` checks the transaction against the
 * intent — recipient, amount, mint *by address*, memo — and reports every
 * failure by name. A payment in a token that shares a ticker with the one you
 * asked for lands perfectly well, and is not your payment.
 *
 * **Is it safe to ship?** Settlement is graded, not boolean. `final` is the
 * default bar because a confirmed transaction can still be dropped, and the
 * whole purpose of this check is to stand between a merchant and shipping
 * against something reversible.
 *
 * The custody boundary is unchanged and unchanged *structurally*: this builds
 * unsigned transactions and the customer's own wallet signs them. Nothing here
 * holds a key, which is why Pay needs no `Signer` and works on a read-only
 * client.
 */

import {
  buildIntentPayment,
  createIntent as createIntentOp,
  describeIntent,
  resolveIntent,
  settleIntent,
  pollLoop,
  qrMatrix,
  qrDataUrl,
  qrPng,
  qrSvg,
  qrUnicode,
  qrArtPng,
  qrArtDataUrl,
  renderQrArt,
  styleFor,
  receiptFacts,
  receiptImage,
  receiptMetadata,
  buildReceiptMint,
} from 'singularity-agent';
import type {
  CreateIntentParams,
  CreatedIntent,
  IntentStore,
  SettlementLevel,
  SettlementResult,
  StoredIntent,
  Subscription,
  WatchOptions,
  Handler,
  ArtStyle,
  ReceiptFacts,
  ReceiptMint,
} from 'singularity-agent';
import { SdkError } from './errors.js';

export type {
  CreateIntentParams,
  CreatedIntent,
  IntentStore,
  SettlementLevel,
  SettlementResult,
  StoredIntent,
};

export interface PayConfig {
  /**
   * Where intents live. A port, not a default — durable payment records belong
   * to your database, not to a library that would lose them on restart.
   * `InMemoryIntentStore` exists for tests and says so in its name.
   */
  store: IntentStore;
  /**
   * The public base URL of your transaction-request endpoint, e.g.
   * `https://pay.example.com/i`. Intent ids are appended as a path segment.
   */
  endpoint: string;
  /**
   * The icon a wallet shows on the approval screen. Defaults to the endpoint's
   * own origin, which is where it belongs: a wallet displays that domain as the
   * thing being trusted, and an icon fetched from elsewhere is the one element
   * of that screen that did not come from where it claims to.
   */
  icon?: string;
}

/** A framework-neutral HTTP reply, so the logic can be tested without a server. */
export interface PayResponse {
  status: number;
  body: unknown;
  headers: Record<string, string>;
}

/**
 * A payment link, in every shape somebody might need to show it.
 *
 * A customer cannot pay a URL. They can scan a QR on a screen, tap a link on
 * the same device, or — at a terminal — look at half-block characters. Handing
 * back only the `solana:` string and leaving rendering as an exercise is what
 * makes a payment integration take an afternoon instead of a minute.
 */
export interface RenderedLink {
  /** The raw `solana:` URL, for an anchor tag or a deep link. */
  url: string;
  /** An `<img src>`-ready PNG. The usual choice for a web checkout. */
  dataUrl: string;
  /** Scalable, for print or a page that zooms. */
  svg: string;
  /** PNG bytes, for a file, an email attachment, or Telegram's sendPhoto. */
  png: Uint8Array;
  /** Half-block characters, for a terminal or a monospaced chat message. */
  unicode: string;
  /**
   * The style this code was drawn in, or `undefined` when `plain` was asked
   * for.
   *
   * Useful for showing a customer what their receipt will look like before
   * they pay, and for a marketplace listing's traits afterwards. It is derived
   * from the reference, so it is the same style the receipt NFT will carry.
   */
  style?: ArtStyle;
}

/**
 * Everything needed to mint one receipt.
 *
 * Deliberately separate from {@link SettlementResult}: settling a payment and
 * minting a token for it are different decisions, and plenty of applications
 * will want the first without the second.
 */
export interface ReceiptBundle {
  /** The verified facts, which refuse to exist for an unsettled payment. */
  facts: ReceiptFacts;
  /** The artwork, as SVG. Re-derivable by anyone holding the reference. */
  image: string;
  /** The off-chain JSON a marketplace reads. Host it and pass the URL back. */
  metadata: Record<string, unknown>;
  /**
   * The unsigned mint, present only once a `uri` and a `payer` are supplied.
   *
   * Absent otherwise, because the metadata has to be hosted somewhere before a
   * transaction can point at it, and that is a round trip this cannot make for
   * you.
   */
  mint?: ReceiptMint;
}

export interface PayApi {
  /**
   * Create a payment request, reading the mint's risk before publishing it.
   *
   * Returns the `solana:` URL for a QR code or a link, the stored intent, and
   * — for token payments — what accepting that mint exposes you to. The risk
   * read does not refuse on its own: plenty of legitimate tokens carry a freeze
   * authority, and whether that is acceptable is a commercial decision rather
   * than a library's. Branch on `risk.custodyIsYours`.
   */
  createIntent(params: CreateIntentParams): Promise<CreatedIntent>;

  /** Fetch an intent, refusing expired and already-paid ones. */
  resolve(id: string): Promise<StoredIntent>;

  /**
   * Render a link as something a customer can actually act on.
   *
   * Takes the `solana:` URL from {@link PayApi.createIntent} — or any other
   * link — and returns it as a QR in four forms. Nothing here touches the
   * network or the store; it is pure rendering, so it is safe to call on a
   * request path.
   */
  qr(
    url: string,
    options?: { scale?: number; margin?: number; plain?: boolean; seed?: string },
  ): RenderedLink;

  /**
   * Turn a settled payment into a receipt NFT.
   *
   * Refuses anything that is not finalized and matching — a token asserting a
   * payment that can still be dropped outlives the transaction it describes,
   * and one asserting a payment that landed in the wrong mint is a forgery
   * with good intentions. Both throw rather than returning a flag, because
   * neither is a case to branch on.
   *
   * Call it in two steps. Without `uri` you get the facts, the artwork and the
   * metadata JSON — host that JSON, then call again with its URL and the
   * payer's address to get the unsigned mint. The SDK signs nothing; the one
   * key involved is a throwaway the mint account needs for its own creation,
   * and it comes back in `mint.mintKeypair` for the caller to use and drop.
   */
  receipt(
    settlement: SettlementResult,
    options?: { uri?: string; payer?: string; mintRent?: number; blockhash?: string; symbol?: string },
  ): ReceiptBundle;

  /**
   * Has this been paid, and is this the call that should act on it?
   *
   * `fulfil` is true exactly once per intent, ever — distinct from
   * `level === 'final'`, which stays true on every later call. A merchant
   * polling in a loop would otherwise ship the same order repeatedly.
   */
  settle(id: string, options?: { require?: SettlementLevel }): Promise<SettlementResult>;

  /**
   * Poll until the payment settles, then stop.
   *
   * Fires on every change to its settlement level, so a UI can show
   * "confirmed, waiting for finality" rather than a spinner that means
   * nothing. Stops on its own once `fulfil` comes back true.
   */
  watch(
    id: string,
    handler: Handler<SettlementResult>,
    options?: WatchOptions & { require?: SettlementLevel },
  ): Subscription;

  /**
   * Handle one transaction-request exchange.
   *
   * Pure: it takes a method, an id and a parsed body, and returns a status and
   * a JSON body. Wire it to whatever server you run — there is no framework
   * assumption here, and it is testable without one.
   *
   *   GET  -> { label, icon }          what the wallet shows beforehand
   *   POST -> { transaction, message } built for the account it sends
   */
  respond(method: string, id: string, body?: { account?: string }): Promise<PayResponse>;
}

/**
 * The seed a link implies.
 *
 * A Solana Pay transfer request carries its reference as a query parameter, so
 * the artwork can be derived from the link alone — no store lookup, no extra
 * argument, and the same answer wherever the link travels. Links without one
 * (a burn payload, a plain URL) fall back to hashing the whole string, which
 * is still stable and still unique to that link.
 */
function seedFromLink(url: string): string {
  const query = url.indexOf('?');
  if (query === -1) return url;

  const reference = new URLSearchParams(url.slice(query + 1)).get('reference');
  return reference ?? url;
}

export function createPay(config: PayConfig): PayApi {
  if (!config?.store) {
    throw new SdkError(
      'NO_CHAIN',
      'Singularity Pay needs an intent store.',
      'Pass `store`. Use InMemoryIntentStore for tests; for production, implement IntentStore against your own database — payment records should not live in a library.',
    );
  }

  if (!config.endpoint) {
    throw new SdkError(
      'NO_CHAIN',
      'Singularity Pay needs the public URL of your endpoint.',
      'Pass `endpoint`, e.g. https://pay.example.com/i — it is what goes inside the solana: link a wallet opens.',
    );
  }

  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Content-Encoding, Accept-Encoding',
    // An intent link is built for one moment and the transaction inside holds a
    // blockhash good for seconds.
    'Cache-Control': 'no-store',
  };

  return {
    createIntent(params) {
      return createIntentOp(config.store, config.endpoint, params);
    },

    resolve(id) {
      return resolveIntent(config.store, id);
    },

    qr(url, options = {}) {
      // No level pinned: the encoder takes the strongest that fits. A payment
      // link's length depends on the domain, the mint and the memo, none of
      // which this knows, and pinning one is how `/pay` came to fail on a
      // 261-byte token payment against a 216-byte ceiling.
      const matrix = qrMatrix(url, {
        ...(options.margin !== undefined ? { margin: options.margin } : {}),
      });
      const scale = options.scale ?? 8;

      if (options.plain) {
        return {
          url,
          dataUrl: qrDataUrl(matrix, { scale }),
          svg: qrSvg(matrix, { scale }),
          png: qrPng(matrix, { scale }),
          unicode: qrUnicode(matrix),
        };
      }

      // Art by default, and seeded from the link itself so this stays pure.
      // The reference is already in the URL — it has to be, since that is how
      // a wallet attaches it — which means the same payment renders the same
      // way here, in the Telegram bot, and on the receipt, without any of them
      // having to agree on anything but the link.
      const seed = options.seed ?? seedFromLink(url);

      return {
        url,
        dataUrl: qrArtDataUrl(matrix, seed, { scale }),
        svg: renderQrArt(matrix, seed, { scale }),
        png: qrArtPng(matrix, seed, { scale }),
        // Unicode has two colours and no geometry, so there is no art to do:
        // half-blocks in a terminal are the matrix and nothing else.
        unicode: qrUnicode(matrix),
        style: styleFor(seed),
      };
    },

    receipt(settlement, options = {}) {
      const facts = receiptFacts(settlement.intent, settlement);
      const image = receiptImage(facts);

      const metadata = receiptMetadata(facts, {
        image: options.uri ?? `data:image/svg+xml;base64,${Buffer.from(image).toString('base64')}`,
        ...(options.symbol ? { symbol: options.symbol } : {}),
      });

      if (!options.uri || !options.payer) return { facts, image, metadata };

      return {
        facts,
        image,
        metadata,
        mint: buildReceiptMint(facts, {
          payer: options.payer,
          uri: options.uri,
          // A rent-exempt 82-byte mint at the rate that has held since 2021.
          // Passing the live value is better and the caller can; defaulting
          // lets a test or a preview run without an RPC round trip.
          mintRent: options.mintRent ?? 1_066_800,
          ...(options.blockhash ? { blockhash: options.blockhash } : {}),
          ...(options.symbol ? { symbol: options.symbol } : {}),
        }),
      };
    },

    settle(id, options = {}) {
      return settleIntent(config.store, id, options);
    },

    watch(id, handler, options = {}) {
      const { require, ...watch } = options;
      let done = false;

      return pollLoop(
        async () => {
          const result = await settleIntent(config.store, id, require ? { require } : {});
          if (result.fulfil) done = true;
          return result;
        },
        // What counts as a change: the settlement level and whether this is the
        // fulfilling call. Not the whole result — it carries a note whose
        // wording moves with the level, and a mismatch list that would fire the
        // handler on re-phrasing.
        (result) => `${result.level}|${result.fulfil}|${result.mismatches.length}`,
        handler,
        { ...watch, until: () => done, label: 'singularity-sdk pay' },
      );
    },

    async respond(method, id, body) {
      if (method === 'OPTIONS') return { status: 204, body: null, headers: cors };

      try {
        const intent = await resolveIntent(config.store, id);

        if (method === 'GET') {
          return {
            status: 200,
            body: describeIntent(intent, config.icon),
            headers: cors,
          };
        }

        if (method === 'POST') {
          const account = body?.account?.trim();
          if (!account) {
            return {
              status: 400,
              body: {
                error: 'MISSING_ACCOUNT',
                message: 'A transaction request POST must carry the account that will sign.',
              },
              headers: cors,
            };
          }

          return {
            status: 200,
            body: await buildIntentPayment(intent, account),
            headers: cors,
          };
        }

        return {
          status: 405,
          body: { error: 'METHOD_NOT_ALLOWED', message: `${method} is not supported here.` },
          headers: cors,
        };
      } catch (err) {
        const code = String((err as { code?: unknown })?.code ?? 'ERROR');
        const message = (err as Error)?.message ?? String(err);
        const hint = (err as { hint?: unknown })?.hint;

        // A wallet is the client, so the status carries most of the meaning —
        // but a human will eventually open this URL in a browser and should
        // find a sentence rather than a stack trace.
        const status =
          code === 'INTENT_NOT_FOUND'
            ? 404
            : code === 'INTENT_EXPIRED' || code === 'INTENT_ALREADY_PAID'
              ? 410
              : code === 'PAY_UNSUPPORTED'
                ? 501
                : 400;

        return {
          status,
          body: { error: code, message, ...(typeof hint === 'string' ? { hint } : {}) },
          headers: cors,
        };
      }
    },
  };
}
