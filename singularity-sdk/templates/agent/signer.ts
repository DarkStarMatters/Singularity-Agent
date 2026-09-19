/**
 * A signer stub. It throws. That is the point.
 *
 * `singularity-sdk` ships no signer implementation and holds no keys — see the
 * long note at the top of the SDK's `signer.ts` for why. This file is the
 * shape you fill in, and it is left throwing rather than shipped working
 * because a keypair signer sitting in a template, one uncomment from active,
 * is the single most reliable way to get a private key committed to a public
 * repository.
 *
 * ── Implementing it ───────────────────────────────────────────────────────
 *
 * Pick whichever of these matches where your keys already live. None of them
 * require this file to ever see a secret:
 *
 * **A browser wallet** (MetaMask, Phantom, Keplr). The wallet signs and
 * usually insists on broadcasting too — implement `sign` by asking it, and
 * either implement `send` by asking it as well, or leave `send` off and let it
 * broadcast. A receipt with `broadcast: false` is the correct outcome there.
 *
 * **A KMS or HSM** (AWS KMS, GCP KMS, YubiHSM). `sign` calls the service;
 * `address` derives from the public key you already have. The secret never
 * leaves the device, which is the whole reason to use one.
 *
 * **A hardware wallet** (Ledger, Trezor). `sign` goes over the transport and
 * blocks on the user pressing a button. Implement `send` yourself against an
 * endpoint you control.
 *
 * **A review queue.** `sign` files the transaction for a human and throws
 * `PENDING_APPROVAL`; a separate worker signs and sends it later. Perfectly
 * legitimate — the SDK does not assume `sign` returns quickly.
 *
 * **A local keypair**, for a testnet or a throwaway. If you do this: read the
 * key from an environment variable, never from a file in the repository, add
 * `.env` to `.gitignore` (it already is), and do not point it at mainnet.
 *
 * ── Two checks the SDK makes, and why ─────────────────────────────────────
 *
 * The SDK verifies that `families` covers the chain before anything is built,
 * and that `SignedTx.chain` matches what it asked you to sign. The second one
 * matters: a signer that returns a mainnet signature for a payload built
 * against a testnet produces a completely valid transaction, and there is no
 * other place that would catch it.
 */

import type { ChainSpec, SignedTx, Signer, UnsignedTx } from 'singularity-sdk';

export const signer: Signer = {
  // Narrow this to what you actually implement. An EVM-only signer that claims
  // 'svm' here fails somewhere inside an encoder instead of on the first line
  // with a readable reason.
  families: ['evm'],

  async address(chain: ChainSpec): Promise<string> {
    throw notImplemented(`address(${chain.id})`);
  },

  async sign(_tx: UnsignedTx, chain: ChainSpec): Promise<SignedTx> {
    throw notImplemented(`sign(${chain.id})`);

    // The shape to return. `raw` is the signed transaction in whatever wire
    // format the chain uses — RLP on EVM, a serialized message on Solana, a
    // `TxRaw` on Cosmos. The SDK never inspects it.
    //
    // return {
    //   chain: chain.id,
    //   family: chain.family,
    //   raw: '0x…',
    //   encoding: 'hex',
    //   expectedHash: '0x…',   // optional, when you can know it before sending
    // };
  },

  // Optional. Leave it off and `sdk.write.*` returns the signed bytes with
  // `broadcast: false` for you to route yourself — which is exactly right when
  // a wallet or a review step owns the send.
  //
  // async send(tx: SignedTx, chain: ChainSpec): Promise<string> {
  //   return yourEndpoint.broadcast(tx.raw);   // returns the hash it landed under
  // },
};

function notImplemented(what: string): Error {
  return Object.assign(
    new Error(
      `signer.${what} is not implemented. This template ships a stub that throws rather than a working key loader — see the notes at the top of signer.ts.`,
    ),
    { code: 'SIGNER_NOT_IMPLEMENTED' },
  );
}
