/**
 * One burn, one redemption.
 *
 * A burn signature is public the moment it lands. Anyone watching the chain can
 * read it, and nothing about quoting one proves you made it — so a sink built on
 * burns has exactly two jobs beyond confirming the burn happened: decide *which*
 * burn satisfies a claim, and make sure a burn cannot satisfy two.
 *
 * The ledger is deliberately boring: a JSON file beside the config, keyed by
 * signature, written whole. What it is not is a distributed system. Two
 * processes redeeming the same signature at the same instant can both read an
 * empty slot before either writes, and the second write wins; the record step
 * re-reads immediately before writing to narrow that window, and it does not
 * close it. That is worth stating rather than implying, because "already
 * redeemed" is the guarantee somebody will build a payout on. A deployment
 * where two agents redeem concurrently needs a real store, and this file is not
 * pretending to be one.
 */
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { SingularityError } from './errors.js';
import { amount as makeAmount } from './format.js';
import type { BurnEvent, BurnReceipt } from './types.js';

export interface Redemption {
  signature: string;
  chain: string;
  mint: string;
  owner: string;
  /** Base units, as a string — the amount is a bigint and JSON has no such thing. */
  amount: string;
  decimals: number;
  /** What the burner wrote into the transaction, where they wrote anything. */
  memo?: string;
  /** What this burn was redeemed *for*, in the caller's own words. */
  purpose?: string;
  redeemedAt: string;
}

export function ledgerPath(): string {
  return process.env.SINGULARITY_BURNS || join(homedir(), '.singularity', 'burns.json');
}

export function readLedger(): Record<string, Redemption> {
  const path = ledgerPath();
  if (!existsSync(path)) return {};

  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, Redemption>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err) {
    // Not recovered from by starting fresh. An unreadable ledger and an empty
    // one are the same object in memory, and treating the first as the second
    // silently re-opens every burn ever redeemed.
    throw new SingularityError(
      'BAD_BURN_LEDGER',
      `Could not read the burn ledger at ${path}: ${(err as Error).message}`,
      'Fix or move the file. It is not treated as empty, because an empty ledger would let every burn already redeemed be redeemed again.',
    );
  }
}

export function findRedemption(signature: string): Redemption | undefined {
  return readLedger()[signature];
}

/** Record a redemption, refusing to overwrite one already there. */
export function recordRedemption(entry: Redemption): Redemption {
  const path = ledgerPath();
  const ledger = readLedger();

  const existing = ledger[entry.signature];
  if (existing) throw alreadyRedeemed(existing);

  ledger[entry.signature] = entry;
  mkdirSync(dirname(path), { recursive: true });

  // Written to one side and moved into place, so an interrupted write cannot
  // leave a half-file where the ledger used to be — which `readLedger` would
  // then refuse to parse, which is safe but means nobody can redeem anything.
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
  renameSync(temporary, path);

  return entry;
}

export function alreadyRedeemed(existing: Redemption): SingularityError {
  return new SingularityError(
    'BURN_ALREADY_REDEEMED',
    `Burn ${existing.signature.slice(0, 10)}… was already redeemed on ${existing.redeemedAt}${
      existing.purpose ? ` for ${existing.purpose}` : ''
    }.`,
    'A burn is one event and redeems once. Quoting the same signature again is not a second burn — make another one.',
  );
}

/** What a claim asks of a burn before it counts. */
export interface BurnCriteria {
  /** The mint that must have been burned. Matched by address, never by symbol. */
  mint: string;
  /** The wallet that must have signed for it, where the claim names one. */
  owner?: string;
  /** The least that must have been destroyed, in base units. */
  minimum?: bigint;
}

/**
 * Pick the burn in a receipt that satisfies a claim, or explain why none does.
 *
 * Every mismatch names what was actually found. A claim failing because the
 * transaction burned a *different* mint is the interesting case by far — it is
 * what someone sending a burn of a worthless token in place of the real one
 * looks like, and an error saying only "no matching burn" would leave the
 * person reading it thinking their own transaction had failed.
 */
export function selectBurn(receipt: BurnReceipt, criteria: BurnCriteria): BurnEvent {
  const ofMint = receipt.burns.filter((burn) => burn.mint === criteria.mint);

  if (!ofMint.length) {
    const found = [...new Set(receipt.burns.map((burn) => burn.mint))];
    throw new SingularityError(
      'BURN_MINT_MISMATCH',
      `That transaction burned ${found.join(', ')}, not ${criteria.mint}.`,
      'A burn counts for the mint it destroyed. Identity is the address — a token wearing the right symbol at the wrong address is a different token.',
    );
  }

  const byOwner = criteria.owner
    ? ofMint.filter((burn) => burn.owner === criteria.owner)
    : ofMint;

  if (!byOwner.length) {
    throw new SingularityError(
      'BURN_OWNER_MISMATCH',
      `That burn was signed by ${ofMint.map((burn) => burn.owner).join(', ')}, not ${criteria.owner}.`,
      'The authority on the burn instruction is who destroyed the tokens. Anyone can quote a signature; only the owner could sign it.',
    );
  }

  // Several burns of one mint by one owner in a single transaction are one
  // event as far as a claim is concerned, so the amounts add up.
  const total = byOwner.reduce((sum, burn) => sum + BigInt(burn.amount.raw), 0n);
  const first = byOwner[0]!;

  if (criteria.minimum !== undefined && total < criteria.minimum) {
    throw new SingularityError(
      'BURN_BELOW_MINIMUM',
      `That burn destroyed ${total} base units and the claim needs at least ${criteria.minimum}.`,
      'Burn the difference in a second transaction; each signature redeems separately.',
    );
  }

  // Rebuilt rather than patched: an amount carries a raw value and a formatted
  // one, and editing the first while keeping the second is how a result comes to
  // disagree with itself.
  return byOwner.length === 1
    ? first
    : { ...first, amount: makeAmount(total, first.amount.decimals, first.amount.symbol) };
}
