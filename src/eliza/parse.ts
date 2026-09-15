/**
 * Pulling arguments out of a sentence.
 *
 * The Telegram bot gets `/balance 0xabc… base` — positional and unambiguous.
 * An Eliza action gets "what's vitalik.eth holding on base and arbitrum?" and
 * has to find the same three things in it.
 *
 * Detection is reused rather than re-implemented: `detect()` already knows what
 * every address and hash format on every supported family looks like, and
 * `getChain()` already knows every chain id, alias, name and numeric id. This
 * module only splits the text into candidate words and asks them.
 */
import { detect } from '../core/detect.js';
import { getChain } from '../core/registry.js';

export interface ParsedQuery {
  /** An address or a name (ENS/SNS) — whatever the user is asking about. */
  subject?: string;
  /** A transaction hash, when one was named. */
  txHash?: string;
  /** Chains named in the text, in the order they appeared. */
  chains: string[];
  /** A decimal quantity, for transfer building. */
  amount?: string;
  /** A token symbol or contract address, for transfer building. */
  token?: string;
}

/**
 * Splits on whitespace and on punctuation that cannot appear inside any
 * identifier we care about. `.` and `-` are deliberately kept: they are part of
 * `vitalik.eth`, `bc1q…`, and chain ids like `arbitrum-nova`. Trailing sentence
 * punctuation is trimmed separately so "on base?" still finds `base`.
 */
export function tokenize(text: string): string[] {
  return text
    .split(/[\s,;:()[\]{}"'`]+/)
    .map((word) => word.replace(/[.?!]+$/, ''))
    .filter(Boolean);
}

const DECIMAL = /^\d+(\.\d+)?$/;
/** Words that look like chain names but are really English. */
const NOT_A_CHAIN = new Set(['a', 'i', 'on', 'the', 'is', 'it', 'me', 'my', 'to', 'for', 'of']);

export function parseQuery(text: string): ParsedQuery {
  const result: ParsedQuery = { chains: [] };
  const words = tokenize(text);

  for (const word of words) {
    if (!result.subject || !result.txHash) {
      const detection = detect(word);
      if (detection.kind === 'tx' && !result.txHash) {
        result.txHash = word;
        continue;
      }
      if ((detection.kind === 'address' || detection.kind === 'name') && !result.subject) {
        result.subject = word;
        continue;
      }
    }

    if (DECIMAL.test(word) && result.amount === undefined) {
      result.amount = word;
      continue;
    }

    const chain = asChainId(word);
    if (chain && !result.chains.includes(chain)) result.chains.push(chain);
  }

  return result;
}

/**
 * A transfer's token is whichever symbol-shaped word is left over. It is looked
 * for only after the chains are known, so "send 5 USDC on base" does not read
 * `base` as the token.
 */
export function parseTransfer(text: string): ParsedQuery {
  const query = parseQuery(text);
  if (query.amount === undefined) return query;

  const words = tokenize(text);
  const amountIndex = words.findIndex((w) => w === query.amount);

  for (const word of words.slice(amountIndex + 1)) {
    if (word === query.subject || asChainId(word)) continue;
    // Symbols are short and alphanumeric; anything else is sentence filler.
    if (/^[A-Za-z][A-Za-z0-9]{1,11}$/.test(word) && word === word.toUpperCase()) {
      query.token = word;
      break;
    }
  }

  return query;
}

/** Returns the canonical chain id for a word, or null if it names no chain. */
export function asChainId(word: string): string | null {
  if (NOT_A_CHAIN.has(word.toLowerCase())) return null;
  try {
    return getChain(word).id;
  } catch {
    return null;
  }
}
