/**
 * One view of what a set of addresses holds, and the two things it refuses to do.
 *
 * `portfolio` answered for one address at a time, which is not how anybody
 * actually holds anything: an EVM address, a Solana pubkey and a Bitcoin
 * address are one person's holdings and three separate questions. This
 * consolidates them.
 *
 * Consolidating means deciding what may be added together, and that is the
 * whole of this file. **A total is a claim**, and there are exactly two places
 * one can be made honestly:
 *
 * 1. **The same token, on the same chain, across several addresses you gave.**
 *    Unambiguous — same contract, same units, different pockets. Summed.
 * 2. Nothing else.
 *
 * What it will not do:
 *
 * - **It will not add a token to itself across chains.** USDC on Ethereum and
 *   USDC on Base are different contracts with different issuers of record, and
 *   holding one is not holding the other. Bridged supply can be frozen, a
 *   bridge can fail, and the two can trade apart. They are reported side by
 *   side with a count, never as a number.
 * - **It will not merge two contracts because they share a name.** Grouping by
 *   symbol is exactly the operation an impersonating token wants performed on
 *   it: deploy something called USDC, wait to be added to the real one. Only
 *   curated symbols — the ones this tool names from its own text — group by
 *   name at all. Anything whose symbol was read off the chain is keyed by its
 *   address and stands alone, however familiar it looks.
 *
 * There is no fiat pricing here and so no portfolio "value". That is not an
 * omission to fill in later; a value needs a price, a price needs a source, and
 * a sourced price is a different kind of claim than a balance read from a
 * chain.
 */

import type { Amount, BalanceEntry } from './types.js';
import { formatUnits } from './format.js';

/**
 * The part of a balance read this needs.
 *
 * Structural rather than an import of `BalanceResult`, which lives a layer up
 * in `tools/`. Consolidation is arithmetic over entries and has no business
 * depending on the shape of the call that produced them.
 */
export interface ConsolidatableBalance {
  native: BalanceEntry;
  tokens: BalanceEntry[];
}

/** What one of the addresses you asked about holds of one asset on one chain. */
export interface HoldingAtAddress {
  address: string;
  amount: Amount;
  /** Solana wallets can hold several token accounts for one mint. */
  tokenAccounts?: number;
}

/**
 * One asset, on one chain, summed across the addresses that hold it.
 *
 * This is the only total in here, and it is a real one: same contract, same
 * decimals, same chain.
 */
export interface HoldingOnChain {
  chain: string;
  /** Contract, mint or denom. Absent for the chain's native asset. */
  token?: string;
  total: Amount;
  addresses: HoldingAtAddress[];
}

/** One asset, everywhere it was found. */
export interface Holding {
  symbol: string;
  name?: string;
  native: boolean;
  decimals?: number;
  /**
   * The symbol was read off the chain, so whoever deployed the contract chose
   * it. Such a holding is never grouped with anything else by name.
   */
  untrusted?: boolean;
  chains: HoldingOnChain[];
  /** Found on more than one chain, so there is no single number for it. */
  spansChains: boolean;
  /** Present whenever something about this holding cannot be stated as a total. */
  note?: string;
}

/**
 * The key two entries must share to be added together.
 *
 * A curated token groups by symbol, because this tool supplied that symbol and
 * knows which address it belongs to. Everything else groups by address, so two
 * strangers wearing the same ticker stay two rows.
 */
function groupKey(entry: BalanceEntry): string {
  if (entry.token.native) return `native:${entry.token.symbol.toLowerCase()}`;
  if (entry.token.untrusted) return `untrusted:${entry.chain}:${entry.token.address ?? entry.token.symbol}`;
  return `curated:${entry.token.symbol.toLowerCase()}`;
}

/** Same asset, same chain — the one place a sum is honest. */
function chainKey(entry: BalanceEntry): string {
  return `${entry.chain}|${entry.token.address ?? 'native'}`;
}

/**
 * Add base-unit amounts that are known to be the same unit.
 *
 * Refuses to produce a decimal string when any input's scale is unknown: a
 * denom whose decimals nothing declares is summed in base units and says so,
 * rather than being formatted against a guess.
 */
function addAmounts(amounts: Amount[]): Amount {
  const first = amounts[0]!;
  const total = amounts.reduce((sum, a) => sum + BigInt(a.raw), 0n);
  const unknown = amounts.some((a) => a.decimalsUnknown);

  return {
    raw: total.toString(),
    formatted: unknown ? total.toString() : formatUnits(total, first.decimals),
    decimals: unknown ? 0 : first.decimals,
    symbol: first.symbol,
    ...(unknown ? { decimalsUnknown: true as const } : {}),
  };
}

/**
 * Consolidate balances into assets, summing only where a sum means something.
 *
 * Zero balances are dropped: `getBalance` already filters token zeros, and a
 * native zero on a chain the address simply does not use is noise rather than a
 * holding. The chains queried are reported separately, so an absent asset is
 * still distinguishable from an unasked question by reading `completeness`.
 */
export function consolidate(balances: ConsolidatableBalance[]): Holding[] {
  const entries: BalanceEntry[] = [];

  for (const result of balances) {
    if (BigInt(result.native.amount.raw) > 0n) entries.push(result.native);
    for (const token of result.tokens) {
      if (BigInt(token.amount.raw) > 0n) entries.push(token);
    }
  }

  const groups = new Map<string, BalanceEntry[]>();
  for (const entry of entries) {
    const key = groupKey(entry);
    const existing = groups.get(key);
    if (existing) existing.push(entry);
    else groups.set(key, [entry]);
  }

  const holdings: Holding[] = [];

  for (const group of groups.values()) {
    const sample = group[0]!;

    const byChain = new Map<string, BalanceEntry[]>();
    for (const entry of group) {
      const key = chainKey(entry);
      const existing = byChain.get(key);
      if (existing) existing.push(entry);
      else byChain.set(key, [entry]);
    }

    const chains: HoldingOnChain[] = [...byChain.values()].map((onChain) => ({
      chain: onChain[0]!.chain,
      ...(onChain[0]!.token.address ? { token: onChain[0]!.token.address } : {}),
      total: addAmounts(onChain.map((e) => e.amount)),
      addresses: onChain.map((e) => ({
        address: e.address,
        amount: e.amount,
        ...(e.tokenAccounts !== undefined ? { tokenAccounts: e.tokenAccounts } : {}),
      })),
    }));

    chains.sort((a, b) => a.chain.localeCompare(b.chain));

    const spansChains = new Set(chains.map((c) => c.chain)).size > 1;

    const notes: string[] = [];
    if (spansChains) {
      notes.push(
        sample.token.native
          ? `${sample.token.symbol} is the native asset of ${chains.length} chains here. Each is its own balance on its own chain and they are deliberately not added together.`
          : `${sample.token.symbol} was found on ${chains.length} chains as different contracts. Those are different tokens with different issuers of record, so they are listed side by side rather than summed.`,
      );
    }
    if (sample.token.untrusted) {
      notes.push(
        `This symbol was read off the contract at ${sample.token.address ?? 'an unknown address'} rather than supplied by this tool, so it is whatever its deployer chose. It is kept separate from any token of the same name.`,
      );
    }

    holdings.push({
      symbol: sample.token.symbol,
      ...(sample.token.name ? { name: sample.token.name } : {}),
      native: sample.token.native,
      ...(sample.token.decimals !== undefined ? { decimals: sample.token.decimals } : {}),
      ...(sample.token.untrusted ? { untrusted: true as const } : {}),
      chains,
      spansChains,
      ...(notes.length ? { note: notes.join(' ') } : {}),
    });
  }

  // Native assets first — they are what a chain charges fees in and what an
  // empty wallet is empty of — then named tokens, then anything wearing a name
  // it chose for itself. Alphabetical within each, so the output is stable.
  const rank = (h: Holding): number => (h.native ? 0 : h.untrusted ? 2 : 1);
  holdings.sort((a, b) => rank(a) - rank(b) || a.symbol.localeCompare(b.symbol));

  return holdings;
}
