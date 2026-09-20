/**
 * Intents on disk, for the CLI and the bot.
 *
 * `InMemoryIntentStore` says what it is in its name and loses everything on
 * restart, which for a payment record is the worst available failure: the money
 * arrived and the order did not. A bot that gets redeployed mid-checkout would
 * do exactly that.
 *
 * So this is the same shape as `burn-ledger.ts` and carries the same warning,
 * because it has the same limitation. It is a JSON file beside the config,
 * written whole. **It is not a distributed store.** Two processes settling the
 * same intent at the same instant can both read an unsettled record before
 * either writes, and both will believe they won — `markSettled` re-reads
 * immediately before writing to narrow that window, and does not close it.
 *
 * That is worth stating rather than implying, because "fulfil exactly once" is
 * the guarantee somebody will ship goods on. One process is fine. A deployment
 * running two needs a real database, and `IntentStore` is an interface for
 * exactly that reason.
 */

import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { SingularityError } from '../core/errors.js';
import type { IntentStore, StoredIntent } from './intent.js';

export function intentsPath(): string {
  return process.env.SINGULARITY_INTENTS || join(homedir(), '.singularity', 'intents.json');
}

type IntentFile = Record<string, StoredIntent>;

function read(path: string): IntentFile {
  if (!existsSync(path)) return {};

  try {
    return JSON.parse(readFileSync(path, 'utf8')) as IntentFile;
  } catch (err) {
    throw new SingularityError(
      'BAD_INTENT_FILE',
      `Could not parse the intent store at ${path}: ${(err as Error).message}`,
      'Fix the JSON or move the file aside. Deleting it loses the record of which payments were already fulfilled, which is how an order ships twice.',
    );
  }
}

function write(path: string, data: IntentFile): void {
  mkdirSync(dirname(path), { recursive: true });

  // Write-then-rename, so an interrupted write cannot leave a half-file where
  // the payment records used to be.
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  renameSync(temporary, path);
}

/**
 * A JSON-file intent store.
 *
 * Fine for one process. See the note at the top of this file before running two.
 */
export class FileIntentStore implements IntentStore {
  constructor(private readonly path: string = intentsPath()) {}

  async put(intent: StoredIntent): Promise<void> {
    const all = read(this.path);
    all[intent.id] = intent;
    write(this.path, all);
  }

  async get(id: string): Promise<StoredIntent | null> {
    return read(this.path)[id] ?? null;
  }

  async byReference(reference: string): Promise<StoredIntent | null> {
    return Object.values(read(this.path)).find((intent) => intent.reference === reference) ?? null;
  }

  async markSettled(id: string, signature: string): Promise<boolean> {
    // Re-read immediately before writing. This narrows the window between
    // check and write; it does not close it, and the file header says so.
    const all = read(this.path);
    const intent = all[id];

    if (!intent || intent.settledAt) return false;

    all[id] = { ...intent, settledAt: new Date().toISOString(), settledSignature: signature };
    write(this.path, all);
    return true;
  }

  /** Every intent, newest first. For a `/pay list` or an operator poking about. */
  async all(): Promise<StoredIntent[]> {
    return Object.values(read(this.path)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}

/**
 * Recipients this deployment will build a payment request to.
 *
 * The same guard `allowedMints()` puts on burns, for the same reason and a
 * sharper one. A burn endpoint that builds a burn of anything is a phishing
 * primitive; a *payment* endpoint that builds a payment to anything is a
 * better one, because the attacker names the destination and gets paid.
 *
 * It matters most where the command is shared. Anyone in a group chat can type
 * `/pay 50 <their own address>` and receive an official-looking QR under the
 * bot's name — and the next person to scan it has every reason to think the bot
 * vouched for it. Restricting the destinations to ones the operator configured
 * removes the whole category for a config line.
 *
 * Unset means **no recipients**, so the command refuses rather than defaulting
 * to something. There is no sensible default for "who gets paid".
 */
export function allowedRecipients(): string[] {
  const configured = process.env.SINGULARITY_PAY_RECIPIENTS?.trim();
  if (!configured) return [];

  return configured
    .split(',')
    .map((address) => address.trim())
    .filter(Boolean);
}

/** Raise unless this address is one the operator named. */
export function requireAllowedRecipient(address: string): void {
  const allowed = allowedRecipients();

  if (allowed.length === 0) {
    throw new SingularityError(
      'NO_PAY_RECIPIENTS',
      'This deployment has no configured payment recipients, so it will not build a payment request.',
      'Set SINGULARITY_PAY_RECIPIENTS to the address or addresses you want to be paid at. It is deliberately not "anyone": a shared command that builds a payment request to an address the asker chose is a way to get somebody else paid under this bot\'s name.',
    );
  }

  if (!allowed.includes(address)) {
    throw new SingularityError(
      'RECIPIENT_NOT_ALLOWED',
      `This deployment does not build payment requests to ${address}.`,
      `It serves a named set of recipients on purpose. Configured: ${allowed.join(', ')}.`,
    );
  }
}
