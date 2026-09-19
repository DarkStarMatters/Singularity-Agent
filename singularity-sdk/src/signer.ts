/**
 * The custody seam.
 *
 * Singularity Agent's permanent non-goal is "no signing, ever" — not a flag,
 * not a plugin. That is what makes broad autonomy safe to grant: the worst a
 * read-only tool can do is be wrong, and being wrong is recoverable. The moment
 * keys enter the process, a prompt-injected model stops being a nuisance and
 * starts being an exploit.
 *
 * An SDK for building applications has to answer the obvious next question
 * anyway, because an application that can only read is not an application. So
 * the seam moves rather than dissolving: this file defines the *port* a write
 * travels through, and ships no implementation of it. There is no keypair
 * loader here, no wallet adapter, no `fromPrivateKey`, no `process.env.SECRET`.
 * Search this package for a signing primitive and you will not find one — that
 * absence is the product, and `test/custody.test.ts` fails if it stops being
 * true.
 *
 * What that buys, concretely:
 *
 * - The SDK's own network layer stays read-only. It never puts bytes on a
 *   chain. Broadcasting goes out through {@link Signer.send}, which is the
 *   application's code talking to the application's endpoint with the
 *   application's credentials.
 * - Keys live where the application already keeps them — a browser wallet, a
 *   KMS, an HSM, a hardware device, a signing service behind an approval step.
 *   None of those want to hand a secret to a library, and none of them have to.
 * - `build` always works; `write` only exists once a signer is supplied, and
 *   the type system says so before the program runs. See {@link SignerRequired}.
 *
 * The line is therefore honest in both directions. The SDK cannot sign, and it
 * does not pretend an application shouldn't.
 */

import type { ChainFamily, ChainSpec, UnsignedTx } from 'singularity-agent';

/**
 * A transaction the application has signed, on its way to a network.
 *
 * Deliberately opaque. Four families encode a signed transaction four ways —
 * RLP on EVM, a wire-format message on Solana, a serialized witness transaction
 * on Bitcoin, a protobuf `TxRaw` on Cosmos — and normalizing that would mean
 * this package understanding signatures, which is the thing it is built not to
 * do. It carries the bytes, says how they are encoded, and remembers which
 * chain they were meant for.
 */
export interface SignedTx {
  /** The chain id this was signed for. Checked against the send target. */
  chain: string;
  family: ChainFamily;
  /** The signed transaction, encoded per {@link SignedTx.encoding}. */
  raw: string;
  encoding: 'hex' | 'base64';
  /**
   * The hash/signature the signer expects this to land under, when it can know
   * it before broadcast. Solana and Cosmos can; EVM can; Bitcoin can. Absent is
   * fine — {@link Signer.send} is the authority on what actually landed.
   */
  expectedHash?: string;
}

/**
 * Where a write goes when it leaves this SDK.
 *
 * Implement this in your application, against whatever already holds your keys.
 * The SDK calls it; it does not construct it, and it never inspects what is
 * inside.
 *
 * `sign` is required and `send` is not, because those are genuinely different
 * permissions. A hardware wallet signs and hands the bytes back; a browser
 * wallet usually insists on broadcasting itself; a review queue may sign now
 * and send after a human looks at it. A signer without `send` still gets the
 * full build-and-sign pipeline — {@link SignerRequired} gates on `sign`, not on
 * broadcast — and `sdk.write.*` returns the signed bytes for you to route
 * yourself. Asking for `send` you did not implement raises
 * `SIGNER_CANNOT_BROADCAST` naming the gap, rather than silently doing nothing.
 */
export interface Signer {
  /**
   * The families this signer can handle. Checked before anything is built, so
   * an EVM-only wallet asked for a Solana burn fails on the first line with a
   * readable reason rather than inside an encoder.
   */
  readonly families: readonly ChainFamily[];

  /**
   * The address transactions will be signed for, on a given chain.
   *
   * Takes the chain because one secret is many addresses: the same seed is a
   * `0x…` on every EVM chain and a `cosmos1…`/`osmo1…` pair on Cosmos. Asking
   * per chain is what stops a Cosmos Hub address being used as an Osmosis one.
   */
  address(chain: ChainSpec): Promise<string>;

  /** Sign. The SDK hands over exactly what `build` produced, unmodified. */
  sign(tx: UnsignedTx, chain: ChainSpec): Promise<SignedTx>;

  /**
   * Broadcast, and return the hash it landed under.
   *
   * Optional — see the note on {@link Signer}. Where it is implemented, this is
   * the only code path in the whole SDK that writes to a network, and it is
   * yours.
   */
  send?(tx: SignedTx, chain: ChainSpec): Promise<string>;
}

/**
 * What `sdk.write` is when no signer was supplied.
 *
 * A stand-in type with no methods on it, so reaching for a write on a read-only
 * client is a compile error that names its own fix:
 *
 * ```
 * Property 'transfer' does not exist on type 'SignerRequired'.
 * ```
 *
 * The alternative was typing the whole branch `never`, which errors too but
 * says "this expression is not callable" — true, unhelpful, and not obviously
 * about custody. The property below exists only to be read in that message.
 */
export interface SignerRequired {
  readonly __singularity: 'Writes need a Signer. Pass `signer` to createSingularity(); this SDK ships no implementation and holds no keys.';
}

/** Runtime half of {@link SignerRequired}, for callers not using TypeScript. */
export const SIGNER_REQUIRED: SignerRequired = {
  __singularity:
    'Writes need a Signer. Pass `signer` to createSingularity(); this SDK ships no implementation and holds no keys.',
};

/** Narrowing helper: is this a usable signer rather than the stand-in? */
export function isSigner(value: unknown): value is Signer {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<Signer>;
  return (
    typeof candidate.sign === 'function' &&
    typeof candidate.address === 'function' &&
    Array.isArray(candidate.families)
  );
}
