/**
 * A symbol is a name, not an identity.
 *
 * Deploying a contract whose `symbol()` returns "USDC" costs about ten dollars
 * and takes a minute, and it is the entire mechanic behind the most common
 * retail loss on every chain here. The address is the identity; the symbol is
 * whatever the deployer typed. Every surface that renders a balance shows the
 * symbol first and the address — when it shows one at all — as forty-two hex
 * characters nobody compares.
 *
 * {@link sanitizeOnchainText} and the `untrusted` mark already say *this string
 * was chosen by whoever deployed the contract*. That is the general warning. It
 * does not help with the specific case, because the specific case looks exactly
 * like the honest one: a token called USDC, marked untrusted, holding 50,000
 * units. The mark is on the real USDC entry too when it is read off-chain.
 *
 * So this module answers the narrower question the mark cannot: **is this the
 * symbol of something this tool already knows, at a different address?** That
 * comparison is available for free — the curated token map is exactly the list
 * of names worth stealing — and it is the one thing the user cannot do by
 * eye.
 *
 * What this is not: a scam detector. A token can be a fraud without colliding
 * with anything curated, and a collision can be innocent. This reports a fact
 * about two addresses sharing a name, and says so in those words.
 */
import { knownTokens } from './tokens.js';
import type { ChainSpec } from './types.js';

/**
 * A scanned token carrying a name this tool already knows at another address.
 *
 * Kept structured rather than folded into the symbol string, so an enforcement
 * path can act on it. The X publish gate does; a `note` alone would be one more
 * sentence a model may or may not honour.
 */
export interface Impersonation {
  /**
   * - `curated-token` — its *symbol* collides with an entry in this tool's
   *   token map.
   * - `native-asset` — its symbol collides with the chain's own gas asset,
   *   which has no contract at all, so *any* contract claiming the name is
   *   not it.
   * - `curated-name` — its symbol is its own, but its *long name* is a curated
   *   token's long name. Reading `name()` off an unknown contract is what
   *   roadmap 1.4 added, and it opened this: "USD Coin" at an address that is
   *   not USDC's reads as authoritative in every table that shows a name.
   */
  kind: 'curated-token' | 'native-asset' | 'curated-name';
  /**
   * The known asset the collision is with, named by its symbol.
   *
   * For `curated-name` the string that actually collided was the long name;
   * this still reports the ticker, because the ticker is what a reader — and
   * the publish gate — will have in hand.
   */
  symbol: string;
  /** Where the real one lives. Absent for a native asset — there is no address. */
  authentic?: string;
  /** One sentence for whoever is about to read the symbol as identity. */
  note: string;
}

/**
 * Homoglyphs, folded to the Latin letter they are drawn as.
 *
 * Exact string comparison catches the lazy version of this attack. The next
 * version up costs nothing extra: Cyrillic "С" renders identically to Latin
 * "C" in every font, and "USDС" is a different string that is the same picture.
 * Digits belong here for the same reason — "USD0" and "S0L" are read as letters
 * by a human skimming a balance table.
 */
const CONFUSABLES: Record<string, string> = {
  // Cyrillic
  а: 'a', в: 'b', с: 'c', е: 'e', н: 'h', к: 'k', м: 'm', о: 'o', р: 'p',
  ѕ: 's', т: 't', х: 'x', у: 'y', з: 'e', ԁ: 'd', ј: 'j', і: 'i',
  // Greek
  α: 'a', β: 'b', ε: 'e', η: 'h', ι: 'i', κ: 'k', μ: 'm', ν: 'v', ο: 'o',
  ρ: 'p', τ: 't', υ: 'u', χ: 'x', ω: 'w',
  // Digits drawn as letters
  '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't',
  // The pair no sans-serif font distinguishes
  l: 'i',
};

/**
 * The form two symbols are compared in.
 *
 * Case, whitespace, accents, fullwidth forms and homoglyphs all come out,
 * because none of them are a difference a person reading a balance would
 * notice. What survives is the shape of the word.
 *
 * Punctuation deliberately stays. It is tempting to strip — it would catch
 * "USDC." — but punctuation is how honest tokens spell variants of each other:
 * `USDC.e` on Avalanche, `DAI+` on Polygon, `WBTC.b`. Stripping it would
 * manufacture a collision for every one of them, and a check that fires on real
 * holdings is a check that gets turned off. So the limit is stated rather than
 * papered over: a symbol that differs from a curated one only by a punctuation
 * mark is not reported.
 *
 * Exported because the honesty gate needs the same folding to decide whether a
 * composed sentence is talking about the token that collided.
 */
export function symbolKey(symbol: string): string {
  return symbol
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // combining accents
    .replace(/[\s\u200b-\u200f\u2060\ufeff]+/g, '')
    .toLowerCase()
    .split('')
    .map((char) => CONFUSABLES[char] ?? char)
    .join('');
}

/**
 * Does this token wear a name that belongs to something else here?
 *
 * Only called for a symbol that came off the chain. A curated entry carries
 * this tool's own text and is by definition the thing being impersonated, not
 * the impersonator.
 */
export function checkImpersonation(
  chain: ChainSpec,
  token: { symbol: string; name?: string; address: string },
): Impersonation | undefined {
  const key = symbolKey(token.symbol);
  if (!key) return nameCollision(chain, token);

  if (key === symbolKey(chain.nativeCurrency.symbol)) {
    return {
      kind: 'native-asset',
      symbol: chain.nativeCurrency.symbol,
      note:
        `This contract's symbol reads as ${chain.nativeCurrency.symbol}, which is ${chain.name}'s own gas asset ` +
        `and has no contract at all — so this is a token that took the name, not the asset itself. ` +
        `Identity here is the address ${token.address}, never the symbol.`,
    };
  }

  const match = knownTokens(chain.id).find((known) => symbolKey(known.symbol) === key);
  if (!match || sameAddress(match.address, token.address)) return nameCollision(chain, token);

  return {
    kind: 'curated-token',
    symbol: match.symbol,
    authentic: match.address,
    note:
      `This contract's symbol reads as ${match.symbol}, which on ${chain.name} is ${match.address}. ` +
      `This is ${token.address} — a different contract wearing the same name. ` +
      `Anyone can deploy a token called ${match.symbol}; identity is the address.`,
  };
}

/**
 * The same question asked of the long name.
 *
 * Only reachable once the symbol has been cleared, so a token is never reported
 * twice for the same collision — and the symbol is the stronger signal, so it
 * wins when both fire.
 *
 * This exists because roadmap 1.4 started reading `name()` off contracts the
 * tool does not curate. Before that there was no long name to collide with;
 * shipping the read without the check would have been the surface widening
 * with nothing watching it, which is the reason 1.4 was held behind Phase 2 in
 * the first place.
 *
 * The honest limit, stated rather than papered over: the publish gate matches
 * on the *ticker*, so a reply that spells out "USD Coin" and never says USDC
 * is not repaired. Names are phrases, and matching phrases against composed
 * prose is a different and much fuzzier problem than matching a ticker.
 */
function nameCollision(
  chain: ChainSpec,
  token: { name?: string; address: string },
): Impersonation | undefined {
  if (!token.name) return undefined;
  const key = symbolKey(token.name);
  if (!key) return undefined;

  if (key === symbolKey(chain.nativeCurrency.name)) {
    return {
      kind: 'native-asset',
      symbol: chain.nativeCurrency.symbol,
      note:
        `This contract calls itself "${token.name}", which is ${chain.name}'s own gas asset — ` +
        `an asset with no contract at all, so this is a token that took the name. ` +
        `Identity here is the address ${token.address}, never the name.`,
    };
  }

  const match = knownTokens(chain.id).find((known) => symbolKey(known.name) === key);
  if (!match || sameAddress(match.address, token.address)) return undefined;

  return {
    kind: 'curated-name',
    symbol: match.symbol,
    authentic: match.address,
    note:
      `This contract calls itself "${token.name}", which on ${chain.name} is the name of ` +
      `${match.symbol} at ${match.address}. This is ${token.address} — a different contract ` +
      `using the same name. Identity is the address.`,
  };
}

/**
 * Case-insensitively only where case genuinely carries no meaning.
 *
 * EVM addresses are hex with an optional checksum in the casing, so two
 * spellings are the same address. Base58 and bech32 are not — folding case
 * there could call two different mints equal, and the direction of that error
 * is a missed impersonation, which is the one outcome this module exists to
 * prevent.
 */
function sameAddress(a: string, b: string): boolean {
  const left = a.trim();
  const right = b.trim();
  if (left === right) return true;

  const hex = /^0x[0-9a-fA-F]{40}$/;
  return hex.test(left) && hex.test(right) && left.toLowerCase() === right.toLowerCase();
}

/**
 * The standing warning attached to any result carrying a collision.
 *
 * The per-token `note` says which two addresses collided. This says what the
 * consumer is obliged to do about it, in the same message, the way
 * `UNTRUSTED_NOTE` does for on-chain text.
 */
export const IMPERSONATION_NOTE =
  'One or more tokens in this result carry `impersonation`: their on-chain symbol is the symbol of a different, known asset. Never refer to such a token by that symbol without saying it is a different contract, and never treat the balance as a holding of the real asset.';

/** Every collision anywhere in a result, wherever it sits. */
export function findImpersonations(value: unknown): Impersonation[] {
  const found: Impersonation[] = [];
  const seen = new Set<unknown>();

  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (!node || typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);

    if (isImpersonation(node)) {
      found.push(node);
      return;
    }
    for (const child of Object.values(node as Record<string, unknown>)) walk(child);
  };

  walk(value);
  return found;
}

/**
 * Matched on shape rather than on the key it hangs off, for the reason
 * `findCompleteness` learned the hard way: a caveat the enforcement cannot find
 * is the same as no caveat.
 */
function isImpersonation(value: unknown): value is Impersonation {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.symbol === 'string' &&
    typeof record.note === 'string' &&
    (record.kind === 'curated-token' ||
      record.kind === 'native-asset' ||
      record.kind === 'curated-name')
  );
}
