/**
 * An alias is the one input this tool does not check.
 *
 * Everything else that arrives as a string is validated against the chain it
 * claims to belong to — forty hex characters, a base58check checksum, a bech32
 * prefix that names its own network. An address-book alias skips all of it by
 * construction: "treasury" is not an address, it is an instruction to go and
 * find one, and whatever comes back is used without the user ever seeing it.
 * That is the entire point of an alias, and it is also what makes it the
 * softest thing in the config.
 *
 * Two ways a saved alias stops meaning what it meant:
 *
 * - **It points at a name.** ENS and SNS registrations expire, get re-registered
 *   by whoever watched the drop, and carry address records the current owner
 *   can rewrite at will. `treasury.eth` resolving to a different address than it
 *   did last month is not an error condition anywhere in this codebase — it is
 *   a successful resolution, and it is byte-for-byte indistinguishable from the
 *   honest one.
 * - **The file changed.** A config file is a file. Anything that can write to
 *   the user's home directory can repoint an alias, and the next
 *   `balance treasury` answers about a stranger's wallet with no seam anywhere
 *   marking that the question changed.
 *
 * A pin closes both. It is the address the alias meant when it was saved, and
 * the rule is that the alias never yields anything else: **every path either
 * matches the pin or raises.** There is deliberately no "the pin looks stale,
 * using the new address" branch — a pin that can be outvoted by the thing it is
 * checking is not a pin, and the silent update is the exact event it exists to
 * make loud.
 *
 * Pinning is opt-in, because the honest use of an alias pointing at a live name
 * is to follow it wherever it goes. What is not acceptable is following it
 * without saying so, which is why an expanded alias is reported by `resolve`
 * even when nothing is pinned.
 */
import { decodeBech32Raw } from './address-codec.js';
import { AliasPinMismatchError, AliasPinUnverifiedError, SingularityError } from './errors.js';
import { loadUserConfig } from './registry.js';

/** A pinned address-book entry: what it points at, and what it must come out as. */
export interface AddressBookEntry {
  /** The address, or the name to resolve, that this alias stands for. */
  target: string;
  /**
   * The address this alias is held to. A resolution landing anywhere else
   * raises instead of answering.
   */
  pin?: string;
}

/** `"vault": "0x…"` is still valid; the object form is what adds a pin. */
export type AddressBookValue = string | AddressBookEntry;

/**
 * An alias expanded, but not yet turned into an address.
 *
 * `target` may still be a name. The address only exists once a caller resolves
 * it, and the caller is the only one that knows how — ENS on one family, SNS on
 * another, nothing at all when the target is already an address — so the pin
 * check cannot happen at lookup time.
 *
 * It happens in {@link AliasTarget.settle}, which is the only thing here that
 * returns an address. A call site that expands an alias and never settles it is
 * left holding `target`, the *unresolved* string, and hands a name to something
 * that wants an address — which fails loudly one line later. That is weaker
 * than a type could enforce and stronger than a comment: the roadmap's standing
 * complaint is that a guarantee living in prose gets broken by code that
 * type-checks, and this at least makes the break visible.
 */
export interface AliasTarget {
  /** The alias as it appears in the book, when the input matched one. */
  alias?: string;
  /** What the alias points at: an address, or a name still to be resolved. */
  target: string;
  /** The address this alias is held to, when it is pinned. */
  pin?: string;
  /**
   * Hold a resolved address to the pin, and return it.
   *
   * `null` means the target resolved to nothing. When the alias is pinned that
   * raises rather than falling back to the pinned address: an expired
   * registration resolves to nothing right up until somebody else registers it,
   * so "cannot be checked" is a finding, not a gap to paper over. Using the pin
   * as the answer would also invert its job — it is the check, not the source.
   */
  settle<T extends string | null | undefined>(address: T): T;
}

/**
 * Look up an input in the user's address book.
 *
 * An input matching nothing comes back as its own unpinned target, so every
 * call site has one shape to handle rather than a string-or-entry union.
 */
export function lookupAlias(input: string): AliasTarget {
  const book = loadUserConfig().addressBook ?? {};
  const written = input.trim();

  // Plain `book[key]` would answer "constructor" and "toString" with members of
  // Object.prototype — an alias nobody wrote, expanding to a function. Own
  // properties only.
  const key = has(book, written)
    ? written
    : has(book, written.toLowerCase())
      ? written.toLowerCase()
      : undefined;

  if (key === undefined) return target(undefined, written, undefined);
  return parseEntry(key, book[key]!);
}

/**
 * Are these the same address?
 *
 * Case folding is decided by the encoding rather than by taste, because getting
 * it wrong in either direction is a real failure: fold too little and an EIP-55
 * checksummed pin reports a mismatch against the lowercase address it names;
 * fold too much and two distinct base58 accounts are called one account, which
 * is the impersonation module's stated mistake made in the one place it would
 * matter most.
 *
 * - **EVM hex** folds. The mixed case in an EIP-55 address is a checksum drawn
 *   over the same twenty bytes; it is presentation.
 * - **bech32** folds, but only once both sides decode with a valid checksum.
 *   The encoding forbids mixed case precisely so that either casing means the
 *   same thing. The prefix stays significant: `cosmos1…` and `osmo1…` are one
 *   key rendered for two chains, and a pin naming one has not verified the
 *   other.
 * - **Everything else** — base58, and anything unrecognized — compares exactly.
 *   Case is data there, and an unrecognized format is not a licence to guess.
 */
export function sameAddress(a: string, b: string): boolean {
  const x = a.trim();
  const y = b.trim();
  if (x === y) return true;

  if (HEX_ADDRESS.test(x) && HEX_ADDRESS.test(y)) return x.toLowerCase() === y.toLowerCase();

  const left = decodeBech32Raw(x);
  const right = decodeBech32Raw(y);
  if (left && right) {
    return (
      left.hrp === right.hrp &&
      left.spec === right.spec &&
      left.words.length === right.words.length &&
      left.words.every((word, i) => word === right.words[i])
    );
  }

  return false;
}

const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

function has(book: Record<string, AddressBookValue>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(book, key);
}

/**
 * Validate one book entry, at the moment it is used.
 *
 * Deliberately not a whole-book pass at load time: a typo in an alias this
 * command never mentions should not stop the command. The entry that matters is
 * checked before it can answer anything, which is the only point where being
 * wrong about it costs something.
 */
function parseEntry(alias: string, value: AddressBookValue): AliasTarget {
  if (typeof value === 'string') {
    const literal = value.trim();
    if (!literal) throw badEntry(alias, 'is empty.', 'Give it an address, or remove it.');
    return target(alias, literal, undefined);
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw badEntry(
      alias,
      'is neither an address string nor an entry object.',
      'Write either "alias": "0x…" or "alias": { "target": "name.eth", "pin": "0x…" }.',
    );
  }

  const pointer = typeof value.target === 'string' ? value.target.trim() : '';
  if (!pointer) {
    throw badEntry(
      alias,
      'has no "target".',
      'An entry object needs a "target" — the address or name the alias stands for.',
    );
  }

  if (value.pin === undefined) return target(alias, pointer, undefined);

  const pin = typeof value.pin === 'string' ? value.pin.trim() : '';
  if (!pin) {
    throw badEntry(
      alias,
      'has an empty "pin".',
      'Give the pin the address this alias must resolve to, or drop the field to leave the alias unpinned.',
    );
  }
  if (pin.includes('.')) {
    throw badEntry(
      alias,
      `has a "pin" of "${pin}", which is a name rather than an address.`,
      'A pin has to be the thing that cannot change out from under you. Pinning one name to another pins nothing.',
    );
  }

  // A literal-address target that disagrees with its own pin is a contradiction
  // in the file, not a hijack: nothing resolved, so nothing moved. Say which
  // line is wrong rather than raising a mismatch the user cannot act on.
  if (!pointer.includes('.') && !sameAddress(pointer, pin)) {
    throw badEntry(
      alias,
      `points at ${pointer} but is pinned to ${pin}.`,
      'Both are literal addresses, so one of them is a typo. A pin is only meaningful on a target that resolves — a name.',
    );
  }

  return target(alias, pointer, pin);
}

function target(alias: string | undefined, pointer: string, pin: string | undefined): AliasTarget {
  return {
    alias,
    target: pointer,
    pin,
    settle<T extends string | null | undefined>(address: T): T {
      if (!pin) return address;
      if (address === null || address === undefined) {
        throw new AliasPinUnverifiedError(alias ?? pointer, pointer, pin);
      }
      if (!sameAddress(address, pin)) {
        throw new AliasPinMismatchError(alias ?? pointer, pin, address);
      }
      return address;
    },
  };
}

function badEntry(alias: string, problem: string, hint: string): SingularityError {
  return new SingularityError('BAD_CONFIG', `Address-book entry "${alias}" ${problem}`, hint);
}
