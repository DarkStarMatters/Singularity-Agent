/**
 * Turning a payment into the numbers that decide what it looks like.
 *
 * A receipt's art is derived from its `reference` — the 32-byte pubkey created
 * when the intent was, attached to the transfer instruction, and used to find
 * the settlement on chain. Seeding from it means the picture is a fingerprint
 * of that one payment rather than decoration: two payments can never render
 * alike, the same payment always renders identically, and anybody holding the
 * reference can re-derive the art and check it matches.
 *
 * That is the same reasoning the rest of this project runs on. The memo says
 * who a burn belongs to, the completeness envelope says what a list covers, and
 * art that meant nothing would be the one thing here that was only pretty.
 *
 * Hashing rather than reading the reference's bytes directly, because a seed
 * should accept any string — an order id, a signature, a reference — and a
 * pubkey's raw bytes are not uniformly distributed in the ways the choices
 * below assume.
 */

import { createHash } from 'node:crypto';

/**
 * A deterministic byte stream.
 *
 * SHA-256 of the seed, then of each previous block, so it never runs out and
 * never repeats within any length worth drawing. Not a cryptographic PRNG and
 * not pretending to be one — nothing here needs unpredictability, only
 * reproducibility.
 */
export class SeedStream {
  private block: Buffer;
  private offset = 0;

  constructor(seed: string) {
    this.block = createHash('sha256').update(seed).digest();
  }

  /** The next byte, 0-255. */
  byte(): number {
    if (this.offset >= this.block.length) {
      this.block = createHash('sha256').update(this.block).digest();
      this.offset = 0;
    }
    return this.block[this.offset++]!;
  }

  /** A number in [0, max), drawn from one byte. */
  below(max: number): number {
    return this.byte() % max;
  }

  /** A number in [min, max], inclusive, drawn from one byte. */
  between(min: number, max: number): number {
    return min + (this.byte() % (max - min + 1));
  }

  /** One of the given values. */
  pick<T>(values: readonly T[]): T {
    return values[this.below(values.length)]!;
  }

  /** A fraction in [0, 1), drawn from two bytes for a little more resolution. */
  fraction(): number {
    return ((this.byte() << 8) | this.byte()) / 65_536;
  }
}
