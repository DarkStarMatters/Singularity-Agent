import { adapterFor } from '../adapters/index.js';
import { styleFor, renderQrArt } from '../art/qr-art.js';
import { contrastRatio } from '../art/palette.js';
import { referenceFromUri } from '../art/receipt.js';
import { qrMatrix } from '../core/qr.js';
import type { TransactionHistory } from '../core/adapter.js';
import {
  auditMint as auditSolanaMint,
  buildBurn as buildSolanaBurn,
  buildPayment as buildSolanaPayment,
  inspectPaymentDemand,
  simulateUnsigned,
  inspectTokenExit,
  verifyBurn as verifySolanaBurn,
} from '../adapters/solana.js';
import type { PaymentDemandReport } from '../pay/types.js';
import { inspectEvmPaymentDemand, simulateUnsignedEvm } from '../adapters/evm.js';
import type { SimulationOutcome } from '../core/simulation.js';
import type { TokenExitReport } from '../trade/types.js';
import { fetchIdentityDocument, isContentAddressed } from '../core/identity.js';
import {
  alreadyRedeemed,
  findRedemption,
  recordRedemption,
  selectBurn,
  type BurnCriteria,
  type Redemption,
} from '../core/burn-ledger.js';
import { allChains, getChain, portfolioChains } from '../core/registry.js';
import {
  classify,
  hostOf,
  probeEndpoint,
  runSerializedByHost,
  type ChainLiveness,
  type ChainTip,
} from '../core/liveness.js';
import {
  finality as finalityOf,
  finalityFromCheckpoint,
  finalityFromCommit,
  finalityFromConfirmations,
  type Finality,
} from '../core/finality.js';
import { lookupAlias, type AliasTarget } from '../core/address-book.js';
import { consolidate, type Holding } from '../core/holdings.js';
import { detect } from '../core/detect.js';
import { SingularityError } from '../core/errors.js';
import { decodeCalldata, decodeWithAbi } from '../core/abi.js';
import { lookupSelector } from '../core/selectors.js';
import { explorerUrl, parseUnits, shortAddress } from '../core/format.js';
import { convertBech32Prefix } from '../core/address-codec.js';
import type { ScanOptions, StateOptions, TransferParams } from '../core/adapter.js';
import type { ResponseBudget } from '../core/budget.js';
import { completeness, weakest, type Completeness } from '../core/envelope.js';
import type {
  BalanceEntry,
  BurnEvent,
  BurnReceipt,
  ChainSpec,
  MintAudit,
  TokenIdentity,
  DecodedCall,
  FeeEstimate,
  NormalizedBlock,
  NormalizedTx,
  ResolvedIdentity,
  UnsignedTx,
} from '../core/types.js';

export interface ChainSummary {
  id: string;
  name: string;
  family: string;
  chainId?: number | string;
  nativeSymbol: string;
  testnet: boolean;
  explorer?: string;
  aliases?: string[];
  rpcCount: number;
}

export function listChains(query?: string, family?: string): ChainSummary[] {
  const needle = query?.trim().toLowerCase();

  return allChains()
    .filter((c) => !family || c.family === family)
    .filter((c) => {
      if (!needle) return true;
      return (
        c.id.includes(needle) ||
        c.name.toLowerCase().includes(needle) ||
        c.nativeCurrency.symbol.toLowerCase().includes(needle) ||
        c.aliases?.some((a) => a.includes(needle)) ||
        String(c.chainId ?? '').toLowerCase().includes(needle)
      );
    })
    .map((c) => ({
      id: c.id,
      name: c.name,
      family: c.family,
      chainId: c.chainId,
      nativeSymbol: c.nativeCurrency.symbol,
      testnet: c.testnet ?? false,
      explorer: c.explorer,
      aliases: c.aliases,
      rpcCount: c.rpc.length,
    }));
}

/**
 * Say that the answer came out of the address book, and what checked it.
 *
 * An alias is the one input whose expansion the user never sees: they ask about
 * "treasury" and get an address back, with nothing in the result saying a file
 * was consulted. That gap is worth closing even when nothing is pinned — an
 * unpinned alias follows a name wherever it currently points, which is a fact
 * about the answer rather than a caveat about the tool.
 */
function withAlias(lookup: AliasTarget, verified: boolean, reason = ''): string {
  if (!lookup.alias) return reason;

  // A name and a literal address are unpinned in different ways: one follows a
  // registration that can change hands, the other is only as stable as the file
  // it sits in. Saying "followed wherever it points" about a raw address would
  // name the wrong risk.
  const unpinned = lookup.target.includes('.')
    ? `Address-book alias "${lookup.alias}" expanded to the name "${lookup.target}", unpinned — it is followed wherever that name points today.`
    : `Address-book alias "${lookup.alias}" expanded to ${lookup.target}, unpinned — nothing here checks that against the address you saved.`;

  const prefix = !lookup.pin
    ? unpinned
    : verified
      ? `Address-book alias "${lookup.alias}" expanded to "${lookup.target}" and matched its pin (${lookup.pin}).`
      : `Address-book alias "${lookup.alias}" is pinned to ${lookup.pin}, and that pin is unchecked here because "${lookup.target}" resolved to nothing.`;

  return `${prefix} ${reason}`.trim();
}

/**
 * Work out what an arbitrary string is, resolving names to addresses where we can.
 */
export async function resolve(input: string, chainHint?: string): Promise<ResolvedIdentity> {
  const lookup = lookupAlias(input);
  const raw = lookup.target;
  const detection = detect(raw);

  const base: ResolvedIdentity = {
    input,
    kind: detection.kind,
    chains: chainHint ? [getChain(chainHint).id] : detection.chains,
    family: detection.families[0],
    note: detection.reason,
  };

  if (lookup.alias) base.alias = lookup.alias;

  if (detection.kind === 'address') {
    // Settled even though nothing was resolved: the address came out of the
    // config file, which is the second thing a pin guards against.
    base.address = lookup.settle(raw);
    base.note = withAlias(lookup, true, base.note);

    // One Cosmos key is one account across every Cosmos chain, just re-encoded.
    // Listing the equivalents turns a confusing "wrong prefix" error into a
    // copy-pasteable answer.
    if (detection.families[0] === 'cosmos') {
      const equivalents: Record<string, string> = {};
      for (const candidate of allChains()) {
        if (candidate.family !== 'cosmos' || !candidate.bech32Prefix) continue;
        const converted = convertBech32Prefix(raw, candidate.bech32Prefix);
        if (converted) equivalents[candidate.id] = converted;
      }
      if (Object.keys(equivalents).length > 1) base.equivalents = equivalents;
    }

    // A reverse ENS lookup turns a bare address into something a human
    // recognizes. It is a nicety, so a failure here must not sink the whole
    // resolve — the address itself is still a valid answer.
    if (detection.families[0] === 'evm') {
      const chain = getChain(chainHint ?? 'ethereum');
      const name = await adapterFor(chain).lookupName?.(chain, raw).catch(() => null);
      if (name) {
        base.name = name;
        base.note = `${base.note} Primary ENS name: ${name}.`;
      }
    }
    return base;
  }

  if (detection.kind === 'name') {
    const chain = getChain(chainHint ?? detection.chains[0] ?? 'ethereum');
    const adapter = adapterFor(chain);

    if (!adapter.resolveName) {
      return {
        ...base,
        note: withAlias(lookup, false, `${detection.reason} No name resolver is wired up for ${chain.name}.`),
      };
    }

    // No catch here: an RPC failure must surface as an RPC failure, not be
    // reported back to the user as "that name does not exist".
    const address = await adapter.resolveName(chain, raw);

    // `resolve` reports what a string is; it never hands an address to anything.
    // So an unresolvable pinned alias is described here rather than thrown —
    // "pinned to 0x…, resolves to nothing today" is a better answer than an
    // exception, and it is still not a silent update. The paths that *act* on
    // an address settle the null case and raise.
    if (!address) {
      return {
        ...base,
        name: raw,
        note: withAlias(
          lookup,
          false,
          `${detection.reason} The name did not resolve — it may be unregistered or have no address record set.`,
        ),
      };
    }
    return {
      ...base,
      address: lookup.settle(address),
      name: raw,
      note: withAlias(lookup, true, base.note),
    };
  }

  return base;
}

/**
 * Normalize a caller-supplied block reference.
 *
 * "latest" and an empty string collapse to `undefined` — current state — so
 * every layer below this can treat "has an atBlock" as "this must be
 * historical or fail". Anything else has to be a plain height: a block *hash*
 * is rejected here rather than passed down, because only some families could
 * honour it and a partial answer to "as of" is worse than none.
 */
export function parseAtBlock(value: string | number | undefined | null): number | undefined {
  if (value === undefined || value === null) return undefined;

  const text = String(value).trim();
  if (!text || text.toLowerCase() === 'latest') return undefined;

  if (!/^\d+$/.test(text)) {
    throw new SingularityError(
      'BAD_BLOCK_REF',
      `"${shortAddress(text, 12, 6)}" is not a block height.`,
      'Pass a decimal height, or "latest" for current state. Block hashes and tags like "safe" are not accepted for state reads.',
    );
  }

  const height = Number(text);
  if (!Number.isSafeInteger(height)) {
    throw new SingularityError('BAD_BLOCK_REF', `Block height ${text} is out of range.`);
  }
  return height;
}

export interface BalanceResult {
  address: string;
  chain: string;
  native: BalanceEntry;
  tokens: BalanceEntry[];
  /**
   * What the token list covers, and what it does not.
   *
   * Always present. Reading `tokens: []` as "this address holds no tokens" is
   * only sound when this says `exhaustive`; on every other kind the absence of
   * a token is an absence of evidence.
   */
  tokenCompleteness: Completeness;
  /** The human sentence from `tokenCompleteness`, kept for existing callers. */
  tokenScanNote?: string;
  /**
   * The height this was read at. Present only on a historical read that was
   * actually served — never echoed back for a call that fell through to
   * current state.
   */
  atBlock?: number;
  explorerUrl?: string;
}

/**
 * What makes two readings of a balance the *same* balance.
 *
 * Used by every watch over `getBalance` — `singularity watch balance` and
 * `sdk.watch.balance` both — which is why it lives here beside the result it
 * describes rather than in either caller. Two copies of this rule would drift,
 * and the drift would be silent: a watch that compares slightly different
 * fields does not fail, it just reports the wrong set of changes.
 *
 * Deliberately not the whole result object. That carries an explorer URL, a
 * block height and a completeness note whose wording moves with the token
 * count — comparing those would fire a handler on cosmetic churn and teach
 * whoever left the terminal open to ignore it.
 *
 * Deliberately not the native amount alone either: a token moving is a balance
 * change, and a watch that misses it is worse than no watch, because it is
 * trusted.
 *
 * Token entries are sorted, so an endpoint returning the same holdings in a
 * different order is not a change.
 */
export function balanceIdentity(balance: BalanceResult): string {
  const tokens = balance.tokens
    .map((entry) => `${entry.token?.symbol ?? entry.token?.address ?? '?'}:${entry.amount.formatted}`)
    .sort()
    .join(',');

  return `${balance.native.amount.formatted}|${tokens}`;
}

export async function getBalance(options: {
  address: string;
  chain: string;
  tokens?: string[];
  includeTokens?: boolean;
  atBlock?: string | number;
  budget?: ResponseBudget;
}): Promise<BalanceResult> {
  const chain = getChain(options.chain);
  const adapter = adapterFor(chain);
  const address = await toAddress(options.address, chain);

  const atBlock = parseAtBlock(options.atBlock);
  const state: StateOptions | undefined = atBlock === undefined ? undefined : { atBlock };

  // The native balance is one entry and has no size to shape, so it takes the
  // state options alone; only the token scan is given a budget.
  const scanOptions: ScanOptions | undefined =
    atBlock === undefined && options.budget === undefined
      ? undefined
      : {
          ...(atBlock === undefined ? {} : { atBlock }),
          ...(options.budget === undefined ? {} : { budget: options.budget }),
        };

  const native = await adapter.getNativeBalance(chain, address, state);

  let tokens: BalanceEntry[] = [];
  let tokenCompleteness = completeness.curated(
    'Token balances were not requested, so none were checked.',
  );

  if (options.includeTokens !== false) {
    try {
      const scan = await adapter.getTokenBalances(chain, address, options.tokens, scanOptions);
      tokens = scan.entries;
      tokenCompleteness = scan.completeness;

      if (atBlock !== undefined) {
        tokenCompleteness = {
          ...tokenCompleteness,
          note: `${tokenCompleteness.note} Token metadata was read at block ${atBlock} too, so a token whose contract did not exist yet is absent from this list rather than shown as zero.`,
        };
      }
    } catch (err) {
      // A refused historical read must not degrade: the native balance came
      // back at a past height, and pairing it with a current-state token list
      // would silently splice two points in time together.
      if (atBlock !== undefined) throw err;

      // Anything else becomes a caveated empty list rather than an exception.
      // The caller still gets the native balance, and — this is the part that
      // matters — the empty token list says out loud that it is empty because
      // the scan failed, not because the wallet is.
      tokenCompleteness = completeness.failed(
        err instanceof SingularityError ? `${err.message} ${err.hint ?? ''}`.trim() : String(err),
      );
    }
  }

  return {
    address,
    chain: chain.id,
    native,
    tokens,
    tokenCompleteness,
    tokenScanNote: tokenCompleteness.note,
    atBlock,
    explorerUrl: explorerUrl(chain, 'address', address),
  };
}

/** One address the caller gave, resolved and matched to the chains it works on. */
export interface PortfolioAddress {
  /** Exactly what was passed in — a name or alias still reads as itself here. */
  input: string;
  address: string;
  chainsQueried: string[];
}

export interface PortfolioResult {
  /**
   * The first address queried.
   *
   * Kept so that callers written against the single-address form read the same
   * as they always did. `addresses` is the whole answer.
   */
  address: string;
  /** Every address asked about, resolved, with the chains each was valid on. */
  addresses: PortfolioAddress[];
  chainsQueried: string[];
  balances: BalanceResult[];
  /**
   * What is held, by asset rather than by chain.
   *
   * Summed only where a sum is honest — same token, same chain, across the
   * addresses you gave. Never across chains and never across two contracts
   * that merely share a ticker. See `core/holdings.ts`.
   */
  holdings: Holding[];
  errors: Array<{ chain: string; address?: string; error: string; hint?: string }>;
  /**
   * The weakest guarantee across every chain queried — what the *combined*
   * answer may claim. One curated EVM scan is enough to make "this address
   * holds nothing anywhere" an unsupported statement, however many chains
   * enumerated cleanly.
   */
  completeness: Completeness;
  note: string;
}

/**
 * Turn one thing the caller typed into an address and the chains it works on.
 *
 * A name has to become an address before any chain can be asked about it —
 * otherwise every chain rejects the name and the whole call looks unsupported.
 */
async function resolveForPortfolio(input: string, requested: string[]): Promise<PortfolioAddress> {
  const lookup = lookupAlias(input);
  const raw = lookup.target;
  const detection = detect(raw);

  let address: string;
  if (detection.kind === 'name') {
    const nameChain = getChain(detection.chains[0] ?? 'ethereum');
    const resolved = lookup.settle((await adapterFor(nameChain).resolveName?.(nameChain, raw)) ?? null);
    if (!resolved) {
      throw new SingularityError(
        'NAME_NOT_RESOLVED',
        `"${raw}" did not resolve to an address.`,
        'The name may be unregistered, expired, or have no address record set.',
      );
    }
    address = resolved;
  } else {
    address = lookup.settle(raw);
  }

  const chains = requested
    .map((id) => getChain(id))
    .filter((chain) => adapterFor(chain).isValidAddress(chain, address))
    .map((chain) => chain.id);

  return { input, address, chainsQueried: chains };
}

/**
 * Query a set of addresses across many chains at once.
 *
 * Takes `addresses` — an EVM address, a Solana pubkey and a Bitcoin address are
 * one person's holdings and were three separate questions until now — or
 * `address` for the single case, which behaves exactly as it did.
 *
 * Each address is matched only to the chains its own format is valid on, so
 * this is not a cross product: a Solana pubkey never produces twenty EVM
 * errors, and adding a Bitcoin address to the set costs one query, not thirty.
 *
 * An address that matches no requested chain is reported in `errors` rather
 * than failing the call. In a set, one unusable address is a gap in the answer;
 * refusing the whole thing over it would throw away every other address's
 * balances. Only a set where *nothing* matched is an error, because then there
 * was no question anyone could have asked.
 */
export async function getPortfolio(options: {
  address?: string;
  addresses?: string[];
  chains?: string[];
  includeTokens?: boolean;
  budget?: ResponseBudget;
}): Promise<PortfolioResult> {
  const given = options.addresses?.length
    ? options.addresses
    : options.address
      ? [options.address]
      : [];

  if (!given.length) {
    throw new SingularityError(
      'NO_ADDRESS',
      'A portfolio needs at least one address.',
      'Pass `address` for one, or `addresses` for a set spanning several chain families.',
    );
  }

  const requested = options.chains?.length ? options.chains : portfolioChains();

  // Deduplicated on what the caller typed: the same wallet pasted twice is one
  // wallet, and summing it into itself would double every balance it holds.
  const unique = [...new Set(given.map((a) => a.trim()).filter(Boolean))];
  const resolved = await Promise.all(unique.map((input) => resolveForPortfolio(input, requested)));

  const errors: PortfolioResult['errors'] = [];
  const jobs: Array<{ address: string; chain: string }> = [];

  for (const entry of resolved) {
    if (!entry.chainsQueried.length) {
      const detection = detect(entry.address);
      errors.push({
        chain: '(none)',
        address: entry.address,
        error: `"${shortAddress(entry.address, 10, 6)}" is not a valid address on any of: ${requested.join(', ')}.`,
        hint: detection.chains.length
          ? `That address works on: ${detection.chains.slice(0, 6).join(', ')}. Pass those as \`chains\`.`
          : detection.reason,
      });
      continue;
    }
    for (const chain of entry.chainsQueried) jobs.push({ address: entry.address, chain });
  }

  if (!jobs.length) {
    const detection = detect(resolved[0]!.address);
    throw new SingularityError(
      'NO_MATCHING_CHAINS',
      given.length === 1
        ? `"${shortAddress(resolved[0]!.address, 10, 6)}" is not a valid address on any of: ${requested.join(', ')}.`
        : `None of the ${unique.length} addresses given is valid on any of: ${requested.join(', ')}.`,
      detection.chains.length
        ? `That address works on: ${detection.chains.slice(0, 6).join(', ')}. Pass those as \`chains\`.`
        : detection.reason,
    );
  }

  const settled = await Promise.allSettled(
    jobs.map((job) =>
      getBalance({
        address: job.address,
        chain: job.chain,
        includeTokens: options.includeTokens,
        // Per chain, not divided between them. A portfolio is a fan-out of
        // independent scans and each one is shaped to the stated budget; this
        // does not pretend to divide a context window across twelve chains,
        // because a caller that wants that arithmetic can name fewer chains.
        ...(options.budget === undefined ? {} : { budget: options.budget }),
      }),
    ),
  );

  const balances: BalanceResult[] = [];

  settled.forEach((result, index) => {
    const job = jobs[index]!;
    if (result.status === 'fulfilled') {
      balances.push(result.value);
      return;
    }
    const err = result.reason;
    errors.push({
      chain: job.chain,
      address: job.address,
      error: err instanceof Error ? err.message : String(err),
      hint: err instanceof SingularityError ? err.hint : undefined,
    });
  });

  const combined =
    weakest([
      ...balances.map((b) => b.tokenCompleteness),
      ...errors.map((e) => completeness.failed(`${e.chain}: ${e.error}`)),
    ]) ?? completeness.failed('No chain answered.');

  const queried = [...new Set(jobs.map((j) => j.chain))];

  return {
    address: resolved[0]!.address,
    addresses: resolved,
    chainsQueried: queried,
    balances,
    holdings: consolidate(balances),
    errors,
    completeness: combined,
    note:
      `Balances only — no fiat pricing, so there is no total value here. ` +
      `${unique.length === 1 ? 'One address' : `${unique.length} addresses`} across ${queried.length} chain(s). ` +
      'Chains where an address format does not apply were skipped, not queried and failed. ' +
      'Holdings are summed only within a chain; the same ticker on two chains is two tokens and is never added together.',
  };
}

/**
 * What an address has been doing, on one named chain.
 *
 * Deliberately single-chain, unlike `portfolio`. Fanning a history query across
 * chains would multiply a paginated, per-family-limited answer by the number of
 * chains and hand back something whose completeness nobody could state — and
 * the completeness is the part that matters here more than the entries.
 *
 * A family with no `getHistory` is a third answer, distinct from both "no
 * activity" and "not configured", and it is reported as its own thing rather
 * than folded into an empty list.
 */
export async function getHistory(options: {
  address: string;
  chain: string;
  limit?: number;
  cursor?: string;
  budget?: ResponseBudget;
}): Promise<TransactionHistory> {
  const chain = getChain(options.chain);
  const adapter = adapterFor(chain);

  if (!adapter.getHistory) {
    return {
      chain: chain.id,
      address: options.address,
      entries: [],
      completeness: completeness.failed(
        `Transaction history is not implemented for ${chain.name}. Nothing was queried, so this says nothing about whether the address has been used.`,
      ),
    };
  }

  return adapter.getHistory(chain, options.address.trim(), {
    ...(options.limit !== undefined ? { limit: options.limit } : {}),
    ...(options.cursor !== undefined ? { cursor: options.cursor } : {}),
    ...(options.budget !== undefined ? { budget: options.budget } : {}),
  });
}

/**
 * Which chains actually answered, and which only appeared to be asked.
 *
 * Pure, and separated from the search for the reason the rest of this codebase
 * separates judging from reading: the interesting case is every endpoint
 * failing at once, which is not a thing you can arrange against live RPCs.
 *
 * The distinction it draws is the whole point. A chain that answers "not here"
 * has been searched, and its silence is evidence. A chain whose endpoint threw
 * has not been searched at all, and reporting it as though it had is how an
 * absence gets asserted about somewhere nothing ever successfully looked.
 * `TX_NOT_FOUND` is the adapters' way of saying the former; anything else is
 * the latter.
 */
export function partitionSearch<T>(
  chainIds: string[],
  settled: PromiseSettledResult<T>[],
): {
  hits: T[];
  searched: string[];
  unreachable: Array<{ chain: string; error: string; hint?: string }>;
} {
  const hits: T[] = [];
  const searched: string[] = [];
  const unreachable: Array<{ chain: string; error: string; hint?: string }> = [];

  settled.forEach((result, index) => {
    const chain = chainIds[index] ?? `#${index}`;

    if (result.status === 'fulfilled') {
      hits.push(result.value);
      searched.push(chain);
      return;
    }

    const reason: unknown = result.reason;
    if (reason instanceof SingularityError && reason.code === 'TX_NOT_FOUND') {
      searched.push(chain);
      return;
    }

    unreachable.push({
      chain,
      error: reason instanceof Error ? reason.message : String(reason),
      ...(reason instanceof SingularityError && reason.hint ? { hint: reason.hint } : {}),
    });
  });

  return { hits, searched, unreachable };
}

/**
 * Fetch a transaction. Without a chain hint, search the chains the hash format
 * allows, in parallel, and report every chain it was found on.
 */
export async function getTransaction(options: {
  hash: string;
  chain?: string;
}): Promise<{
  found: NormalizedTx[];
  /** Chains that actually answered — found it, or reported it absent. */
  searched: string[];
  /** Chains whose endpoint failed. Absence was NOT established on these. */
  unreachable?: Array<{ chain: string; error: string; hint?: string }>;
  note?: string;
}> {
  const hash = options.hash.trim();

  if (options.chain) {
    const chain = getChain(options.chain);
    const tx = await adapterFor(chain).getTransaction(chain, hash);
    return { found: [await withFinality(chain, tx)], searched: [chain.id] };
  }

  const detection = detect(hash);
  if (detection.kind !== 'tx') {
    throw new SingularityError(
      'NOT_A_TX_HASH',
      `"${shortAddress(hash, 12, 8)}" does not look like a transaction hash.`,
      detection.reason,
    );
  }

  // Searching every EVM chain would hammer a dozen public RPCs; the common
  // chains cover nearly everything anyone pastes.
  const searchSet = detection.chains.filter((id) => SEARCH_CHAINS.includes(id));
  const candidates = (searchSet.length ? searchSet : detection.chains.slice(0, 6)).map(getChain);

  const settled = await Promise.allSettled(
    candidates.map((chain) => adapterFor(chain).getTransaction(chain, hash)),
  );

  // A chain that answers "not here" has been searched. A chain whose endpoint
  // failed has not, and the difference is the whole value of the answer: before
  // this, every rejection was dropped and the error below then asserted the
  // hash was absent from chains nothing had successfully asked. That is the
  // same failure `getPortfolio` collects `errors` for and `evm.ts` counts
  // unreachable contracts for — reported here rather than silently folded into
  // an absence.
  const { hits, searched, unreachable } = partitionSearch(
    candidates.map((c) => c.id),
    settled,
  );

  const found = await Promise.all(hits.map((tx) => withFinality(getChain(tx.chain), tx)));

  if (!found.length) {
    // Nothing answered at all. This is not an absence and must not be reported
    // as one — there is no evidence about the hash either way.
    if (searched.length === 0) {
      throw new SingularityError(
        'TX_SEARCH_UNAVAILABLE',
        `None of the ${candidates.length} chain(s) that could hold ${shortAddress(hash, 12, 8)} would answer, so nothing is known about this transaction.`,
        `Unreachable: ${unreachable.map((u) => `${u.chain} (${u.error})`).join('; ')}. This is not evidence the transaction does not exist. Pass \`chain\` to query one directly, or set your own endpoint.`,
      );
    }

    throw new SingularityError(
      'TX_NOT_FOUND',
      `Transaction ${shortAddress(hash, 12, 8)} was not found on any of: ${searched.join(', ')}.`,
      unreachable.length
        ? `${unreachable.length} further chain(s) did not answer and were not searched — ${unreachable.map((u) => u.chain).join(', ')} — so this is not evidence the transaction is absent from those.`
        : 'Pass `chain` explicitly if it is on a chain outside the default search set, or the transaction may not exist.',
    );
  }

  return {
    found,
    searched,
    ...(unreachable.length ? { unreachable } : {}),
    note:
      found.length > 1
        ? 'This hash exists on more than one chain. That is normal for deterministic deployments and replayed transactions — check the chain field on each.'
        : undefined,
  };
}

/**
 * Attach what this transaction's inclusion is worth.
 *
 * A pending transaction is given the reversible answer directly rather than
 * being sent through a height it does not have: "not in a block yet" is a
 * stronger and more useful statement than "unknown", and they are easy to
 * confuse once both are absent.
 */
async function withFinality(chain: ChainSpec, tx: NormalizedTx): Promise<NormalizedTx> {
  if (tx.blockNumber === undefined) {
    return {
      ...tx,
      finality: finalityOf.reversible(
        'This transaction is not in a block yet, so there is nothing to be final about. It can still be replaced or dropped.',
      ),
    };
  }

  const resolved = await resolveFinality(chain, tx.blockNumber);
  return resolved ? { ...tx, finality: resolved } : tx;
}

/** Chains searched when a tx hash arrives with no chain specified. */
const SEARCH_CHAINS = [
  'ethereum',
  'base',
  'arbitrum',
  'optimism',
  'polygon',
  'bsc',
  'bitcoin',
  'cosmoshub',
  'osmosis',
];

export async function getBlock(options: {
  chain: string;
  ref?: string | number;
}): Promise<NormalizedBlock> {
  const chain = getChain(options.chain);
  const block = await adapterFor(chain).getBlock(chain, options.ref ?? 'latest');
  return { ...block, finality: await resolveFinality(chain, block.number) };
}

/**
 * The finalized height and the tip, cached briefly.
 *
 * Finality is the slowest-moving number on any chain here — two epochs on
 * Ethereum is nearly thirteen minutes, and a Tendermint commit is instant but
 * costs a request to learn. Asking for both on every read would add a round
 * trip to operations that currently take one, to answer a question whose
 * answer barely changes.
 *
 * The TTL is short enough that the tip stays honest for a confirmation count
 * and long enough that a burst of reads pays for one lookup. It is deliberately
 * not longer: a stale *finalized* height is harmless because it can only
 * understate finality, but a stale *tip* overstates confirmations, and that
 * error points the wrong way.
 */
const FINALITY_TTL_MS = 8_000;

interface FinalityHeads {
  tip: number | null;
  finalized: number | null;
  readAt: number;
}

const finalityHeads = new Map<string, FinalityHeads>();

async function headsFor(chain: ChainSpec): Promise<FinalityHeads> {
  const cached = finalityHeads.get(chain.id);
  if (cached && Date.now() - cached.readAt < FINALITY_TTL_MS) return cached;

  const adapter = adapterFor(chain);

  // Both are best-effort. A finality annotation must never be the reason a
  // balance call fails — the worst it may do is decline to make a claim.
  const [tip, finalized] = await Promise.all([
    tipReader(chain)(chain)
      .then((head) => head.height)
      .catch(() => null),
    adapter.finalizedHeight?.(chain).catch(() => null) ?? Promise.resolve(null),
  ]);

  const heads: FinalityHeads = { tip, finalized, readAt: Date.now() };
  finalityHeads.set(chain.id, heads);
  return heads;
}

/** Drops the cached heads. Exists so tests are not at the mercy of the clock. */
export function resetFinalityCache(): void {
  finalityHeads.clear();
}

/**
 * What a result read at `height` is actually worth on this chain.
 *
 * Dispatches on family because the four do not agree on what settlement is —
 * see `src/core/finality.ts`. UTXO never reaches `final` and Cosmos always
 * does; the two checkpoint families are the only ones with a gap to measure.
 */
export async function resolveFinality(
  chain: ChainSpec,
  height: number | undefined,
): Promise<Finality | undefined> {
  if (height === undefined || !Number.isFinite(height)) return undefined;

  if (chain.family === 'cosmos') return finalityFromCommit(height);

  const heads = await headsFor(chain);

  if (chain.family === 'utxo') {
    if (heads.tip === null) {
      return finalityOf.unknown(
        `The chain tip could not be read, so the number of confirmations on block ${height} is unknown.`,
        { height },
      );
    }
    return finalityFromConfirmations(height, heads.tip);
  }

  return finalityFromCheckpoint({
    family: chain.family,
    height,
    finalizedHeight: heads.finalized,
    ...(heads.tip !== null ? { tipHeight: heads.tip } : {}),
  });
}

export async function getFees(chainRef: string): Promise<FeeEstimate> {
  const chain = getChain(chainRef);
  return adapterFor(chain).estimateFees(chain);
}

export async function buildTransfer(options: TransferParams & { chain: string }): Promise<UnsignedTx> {
  const chain = getChain(options.chain);
  const adapter = adapterFor(chain);

  const to = await toAddress(options.to, chain);
  const from = options.from ? await toAddress(options.from, chain) : undefined;

  return adapter.buildTransfer(chain, { ...options, to, from });
}

export async function readContract(options: {
  chain: string;
  address: string;
  method?: string;
  abi?: string;
  args?: unknown[];
  atBlock?: string | number;
}): Promise<unknown> {
  const chain = getChain(options.chain);
  const adapter = adapterFor(chain);

  if (!adapter.readContract) {
    throw new SingularityError(
      'UNSUPPORTED',
      `Contract reads are not supported on ${chain.name}.`,
    );
  }

  const address = await toAddress(options.address, chain);
  return adapter.readContract(chain, {
    ...options,
    address,
    atBlock: parseAtBlock(options.atBlock),
  });
}

/**
 * Decode calldata.
 *
 * `lookup` is opt-in and off by default. It sends the selector to a public
 * 4-byte directory, which is both a disclosure the caller should make
 * deliberately and an answer from a source anyone may write to — see
 * `lookupSelector` for why the result never becomes `signature`.
 */
export async function decode(
  data: string,
  abi?: string[],
  lookup = false,
): Promise<DecodedCall> {
  if (abi?.length) {
    try {
      return decodeWithAbi(data, abi);
    } catch (err) {
      throw new SingularityError(
        'DECODE_FAILED',
        `Calldata did not match the supplied ABI: ${(err as Error).message}`,
        'Check the ABI entry matches the selector in the first 4 bytes of the data.',
      );
    }
  }

  const decoded = decodeCalldata(data);
  // Only when nothing local matched. A directory answer is weaker evidence than
  // a match against this tool's own ABI, so it never gets the chance to
  // contradict one.
  if (!lookup || decoded.signature || !decoded.selector) return decoded;

  const hex = data.startsWith('0x') ? data : `0x${data}`;
  const candidates = await lookupSelector(decoded.selector, hex);
  if (!candidates.length) return decoded;

  const fitted = candidates.filter((candidate) => candidate.args).length;
  return {
    ...decoded,
    candidates,
    note:
      `${candidates.length} candidate signature(s) for ${decoded.selector} came from a public ` +
      '4-byte directory, where anyone may submit an entry for any selector. They are guesses, ' +
      'not identifications. ' +
      (fitted === 1
        ? 'One of them decodes this calldata cleanly and its arguments are shown; that is still not proof it is the right one.'
        : 'None is shown decoded: where more than one fits the bytes there is no evidence for either, and where none fits, none applies.'),
  };
}

/**
 * Accept a name, an address-book alias, or a raw address; always return an
 * address — and never one a pinned alias disowns.
 *
 * Every return here goes through `settle`, which is the whole point: this is
 * the funnel that `balance`, `read_contract` and `build_transfer` all pour
 * through, and an address escaping it unchecked would be an address the pin was
 * never applied to.
 */
async function toAddress(input: string, chain: ChainSpec): Promise<string> {
  const lookup = lookupAlias(input);
  const raw = lookup.target;
  const adapter = adapterFor(chain);

  if (adapter.isValidAddress(chain, raw)) return lookup.settle(raw);

  if (raw.includes('.') && adapter.resolveName) {
    const resolved = lookup.settle(await adapter.resolveName(chain, raw));
    if (resolved) return resolved;
    throw new SingularityError(
      'NAME_NOT_RESOLVED',
      `"${raw}" did not resolve to an address.`,
      'The name may be unregistered, expired, or have no address record set.',
    );
  }

  throw new SingularityError(
    'INVALID_ADDRESS',
    `"${shortAddress(raw, 12, 6)}" is not a valid address on ${chain.name}.`,
    adapter.addressExpectation(chain, raw),
  );
}

export interface EndpointHealthResult {
  chain: string;
  ok: boolean;
  /** Round-trip time of the probe, successful or not. */
  ms: number;
  error?: string;
}

/**
 * Probe every configured endpoint and report which answer.
 *
 * Lives here rather than in the CLI because the Telegram bot needs it too, and
 * "which of my RPCs are down" is the first question when balances start
 * failing. Adapters that expose a cheap `healthCheck` use it; the rest fall
 * back to fetching the chain tip, which every adapter supports.
 *
 * Failures are values, not throws: one unreachable chain must not hide the
 * status of the other forty.
 */
export async function checkEndpoints(chains?: string[]): Promise<EndpointHealthResult[]> {
  const targets = chains?.length ? chains.map((ref) => getChain(ref)) : allChains();

  return Promise.all(
    targets.map(async (chain): Promise<EndpointHealthResult> => {
      const adapter = adapterFor(chain);
      const started = Date.now();

      try {
        if (adapter.healthCheck) await adapter.healthCheck(chain);
        else await adapter.getBlock(chain, 'latest');

        return { chain: chain.id, ok: true, ms: Date.now() - started };
      } catch (err) {
        return {
          chain: chain.id,
          ok: false,
          ms: Date.now() - started,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );
}

/**
 * Whether each chain is serving current state.
 *
 * The stronger question behind {@link checkEndpoints}, which only ever asked
 * whether a request threw. A chain that has stopped producing blocks answers
 * every request it is given, with the right chain id, forever — Polygon zkEVM
 * was serving a head 76 days old while passing that check, and is excluded from
 * this tool for exactly that reason. Reachability cannot see it; a dated head
 * can.
 *
 * Each endpoint is probed separately rather than through failover, since
 * failover's whole job is to paper over the difference between them.
 */
export async function checkLiveness(chains?: string[]): Promise<ChainLiveness[]> {
  const targets = chains?.length ? chains.map((ref) => getChain(ref)) : allChains();

  const jobs = targets.flatMap((chain) => chain.rpc.map((endpoint) => ({ chain, endpoint })));

  const probes = await runSerializedByHost(
    jobs,
    (job) => hostOf(job.endpoint),
    (job) => probeEndpoint(job.chain, job.endpoint, tipReader(job.chain)),
  );

  return targets.map((chain) =>
    classify(
      chain,
      probes.filter((_, index) => jobs[index]!.chain.id === chain.id),
    ),
  );
}

/**
 * How to ask this chain for its head.
 *
 * `getBlock` is the universal answer and the wrong one on Solana, whose public
 * endpoints disable it — so an adapter that knows better says so through
 * `chainTip`. The fallback keeps a block's own timestamp where it has one and
 * passes on the absence where it does not, because an undated head must read as
 * undatable rather than as fresh.
 */
function tipReader(chain: ChainSpec): (target: ChainSpec) => Promise<ChainTip> {
  const adapter = adapterFor(chain);

  if (adapter.chainTip) return (target) => adapter.chainTip!(target);

  return async (target) => {
    const block = await adapter.getBlock(target, 'latest');
    return {
      height: block.number,
      ...(block.timestamp ? { timestamp: block.timestamp } : {}),
    };
  };
}

/**
 * What a mint account permits.
 *
 * Solana only, and the refusal for everything else is deliberate rather than a
 * gap waiting to be filled quietly: "can more be minted, can I be frozen, can
 * somebody take these out of my wallet" are the same *questions* on an EVM
 * chain, but the answers live in contract code rather than in fixed fields, and
 * reading them takes bytecode analysis this tool does not do. Returning a
 * cheerful empty finding list for an ERC-20 would read as "nothing here can
 * happen to you", which is the one thing it must never say.
 */
export async function auditMint(options: { mint: string; chain?: string }): Promise<MintAudit> {
  const chain = getChain(options.chain ?? 'solana');

  if (chain.family !== 'svm') {
    throw new SingularityError(
      'MINT_AUDIT_UNSUPPORTED',
      `${chain.name} is not a Solana chain, and mint authorities and Token-2022 extensions are Solana concepts.`,
      'On an EVM chain the equivalent powers live in contract code rather than in fixed account fields, and this tool does not read bytecode. Use `read_contract` against the specific function you care about.',
    );
  }

  return auditSolanaMint(chain, options.mint);
}

/**
 * Build an unsigned burn.
 *
 * Both addresses pour through `toAddress`, which is not ceremony: an alias is
 * the one input this tool does not validate against a chain, and a burn is the
 * one instruction that cannot be undone. A pinned alias that has drifted stops
 * the call here rather than destroying the wrong mint.
 *
 * Solana only. An ERC-20 has no standard burn — some contracts expose one, most
 * do not, and the usual substitute is a transfer to an address nobody holds the
 * key for, which is not the same thing and must not be built as though it were.
 */
export async function buildBurn(options: {
  mint: string;
  amount: string;
  owner: string;
  memo?: string;
  chain?: string;
}): Promise<UnsignedTx> {
  const chain = getChain(options.chain ?? 'solana');

  if (chain.family !== 'svm') {
    throw new SingularityError(
      'BURN_UNSUPPORTED',
      `Burning is only built for Solana mints, and ${chain.name} is not a Solana chain.`,
      'On an EVM chain a burn is whatever the contract chose to implement, if anything. Sending to a dead address is not a burn and this tool will not build one as if it were.',
    );
  }

  const owner = await toAddress(options.owner, chain);
  const mint = await toAddress(options.mint, chain);

  return buildSolanaBurn(chain, {
    owner,
    mint,
    amount: options.amount,
    ...(options.memo ? { memo: options.memo } : {}),
  });
}

/** A burn, and what it satisfies. */
export interface BurnClaim {
  receipt: BurnReceipt;
  /** The burn that met the claim, where the caller made one. */
  matched?: BurnEvent;
  /** Set when this signature has already been redeemed, and by what.
   *  Present on a verify; a redeem raises instead. */
  redeemed?: Redemption;
}

function solanaChain(named: string | undefined, verb: string): ChainSpec {
  const chain = getChain(named ?? 'solana');
  if (chain.family !== 'svm') {
    throw new SingularityError(
      'BURN_UNSUPPORTED',
      `${verb} is only implemented for Solana, and ${chain.name} is not a Solana chain.`,
      'An ERC-20 has no standard burn, so there is nothing general to read on an EVM chain.',
    );
  }
  return chain;
}

async function criteriaFor(
  chain: ChainSpec,
  options: { mint?: string; owner?: string; minimum?: string; expectMemo?: string },
  receipt: BurnReceipt,
): Promise<BurnCriteria | undefined> {
  if (!options.mint) return undefined;

  const mint = await toAddress(options.mint, chain);
  const owner = options.owner ? await toAddress(options.owner, chain) : undefined;

  // The minimum is a human amount, and the decimals come from the burn the
  // chain recorded rather than from the caller — a claim stated in base units
  // would be off by a factor of a million the first time somebody guessed.
  const decimals = receipt.burns.find((burn) => burn.mint === mint)?.amount.decimals;
  const minimum =
    options.minimum !== undefined && decimals !== undefined
      ? parseUnits(options.minimum, decimals)
      : undefined;

  return { mint, owner, minimum, ...(options.expectMemo ? { memo: options.expectMemo } : {}) };
}

/**
 * Confirm a burn, and say whether it satisfies a claim.
 *
 * Read-only in the strict sense: it touches the ledger to *report* that a
 * signature was already redeemed, and never writes to it. A model asking
 * whether a burn is good for something should get an answer without that
 * question spending it.
 */
export async function verifyBurn(options: {
  signature: string;
  chain?: string;
  mint?: string;
  owner?: string;
  minimum?: string;
  /** Text the burn's memo must contain for this claim to be the caller's. */
  expectMemo?: string;
}): Promise<BurnClaim> {
  const chain = solanaChain(options.chain, 'Burn verification');
  const receipt = await verifySolanaBurn(chain, options.signature);
  const criteria = await criteriaFor(chain, options, receipt);

  return {
    receipt,
    ...(criteria ? { matched: selectBurn(receipt, criteria) } : {}),
    ...(findRedemption(options.signature) ? { redeemed: findRedemption(options.signature)! } : {}),
  };
}

/**
 * Redeem a burn: confirm it, then spend it, once.
 *
 * `mint` is required here and optional on a verify, because redeeming "some
 * burn" is not a thing anybody means. A transaction that burned a worthless
 * token instead of the intended one is the whole reason the check exists.
 *
 * Deliberately absent from the tool catalogue. Every tool there is annotated
 * read-only and this one writes, and it should be a decision somebody takes
 * rather than something a model reaches for mid-sentence. It is reachable from
 * the CLI and the bot, where an operator is driving.
 */
export async function redeemBurn(options: {
  signature: string;
  mint: string;
  chain?: string;
  owner?: string;
  minimum?: string;
  purpose?: string;
  /**
   * Text the burn's memo must contain. Where a caller has an identity of its
   * own — a chat, an account — this is how a burn is credited to *them* rather
   * than to whoever quotes the public signature first.
   */
  expectMemo?: string;
}): Promise<BurnClaim & { redemption: Redemption }> {
  const chain = solanaChain(options.chain, 'Burn redemption');

  // Checked before the network call as well as inside `recordRedemption`. The
  // early one saves a round trip on a replay; the late one is the guarantee.
  const already = findRedemption(options.signature);
  if (already) throw alreadyRedeemed(already);

  const receipt = await verifySolanaBurn(chain, options.signature);
  const criteria = await criteriaFor(chain, options, receipt);
  const matched = selectBurn(receipt, criteria!);

  const redemption = recordRedemption({
    signature: receipt.signature,
    chain: chain.id,
    mint: matched.mint,
    owner: matched.owner,
    amount: matched.amount.raw,
    decimals: matched.amount.decimals,
    ...(receipt.memo ? { memo: receipt.memo.text } : {}),
    ...(options.purpose ? { purpose: options.purpose } : {}),
    redeemedAt: new Date().toISOString(),
  });

  return { receipt, matched, redemption };
}

/**
 * What a mint says it is, and whether that can be changed afterwards.
 *
 * The on-chain half always runs. The document is fetched only when asked,
 * because the uri is a URL whoever deployed the mint chose, and reading it is
 * an outbound request made on a stranger’s say-so — the same deliberate act
 * `decode --lookup` makes of disclosing a selector to a third party.
 *
 * When it is not fetched, `accounts` is **absent** rather than empty. An empty
 * list reads as "this project declares nothing", and that is a finding this
 * call has not earned.
 */
export async function tokenIdentity(options: {
  mint: string;
  chain?: string;
  fetch?: boolean;
}): Promise<TokenIdentity> {
  const chain = solanaChain(options.chain, 'Token identity');
  const mint = await toAddress(options.mint, chain);
  const audit = await auditSolanaMint(chain, mint);

  const mutability = audit.metadata?.mutability ?? 'unknown';
  const uri = audit.metadata?.uri;
  const contentAddressed = uri ? isContentAddressed(uri.text) : false;

  // Both halves have to hold. An immutable pointer at a mutable document is a
  // record that can be rewritten without the chain showing anything at all,
  // which is the more dangerous of the two failures because it looks settled.
  const anchored = mutability === 'immutable' && contentAddressed;

  const immutableNote = !uri
    ? 'This mint points at no document, so there is nothing declared to anchor.'
    : anchored
      ? 'The update authority is revoked and the link addresses its content, so what this mint declares is what it declared when it was made, and nobody can change it now.'
      : mutability === 'mutable'
        ? `The metadata update authority is live, so the name, ticker and link can all be rewritten at this same address.`
        : mutability === 'unknown'
          ? 'Whether this text can be rewritten was not determined — a Metaplex record keeps that in a flag this tool does not decode.'
          : 'The on-chain text is immutable, but the link names a server rather than its own content, so what that link serves can still change.';

  let accounts: TokenIdentity['accounts'];
  let document: TokenIdentity['document'];

  if (options.fetch && uri) {
    try {
      const fetched = await fetchIdentityDocument(uri.text);
      accounts = fetched.accounts;
      document = {
        fetched: true,
        source: fetched.source,
        note:
          fetched.integrity === 'verified'
            ? 'These bytes were hashed and match the CID the mint names, so they are the document it points at and not merely what a gateway served.'
            : fetched.integrity === 'not-checkable'
              ? 'Read from wherever the link points. The CID form here hashes a UnixFS node rather than the file, so the bytes were not checked against it — this is what the gateway served.'
              : 'Read from wherever the link points today. A server can serve something else tomorrow, or serve you and nobody else.',
      };
    } catch (err) {
      // Left absent rather than empty. "Declares nothing" and "could not be
      // read" are the same empty list, and only one of them is a finding.
      document = {
        fetched: false,
        source: uri.text,
        note: `The document could not be read: ${(err as Error).message}`,
      };
    }
  } else if (uri) {
    document = {
      fetched: false,
      source: uri.text,
      note: 'Not fetched. The link is a URL chosen by whoever deployed this mint, so following it is a request made on their say-so — ask for it deliberately.',
    };
  }

  return {
    chain: chain.id,
    mint,
    ...(audit.metadata ? { symbol: audit.metadata.symbol, name: audit.metadata.name } : {}),
    ...(uri ? { uri } : {}),
    immutable: { metadata: mutability, document: contentAddressed, note: immutableNote },
    ...(accounts ? { accounts } : {}),
    ...(document ? { document } : {}),
    ...(audit.impersonation ? { impersonation: audit.impersonation } : {}),
    completeness:
      document?.fetched === true
        ? completeness.exhaustive(
            'Every account this tool recognizes in the document the mint points at, plus what the chain says about whether that can change.',
          )
        : document?.fetched === false && options.fetch
          ? completeness.failed(
              'The document could not be read, so what this mint declares is unknown rather than absent.',
            )
          : completeness.curated(
              'The on-chain half only. The document was not fetched, so no account this mint may declare has been seen.',
            ),
    note:
      'Identity here is the mint address. A name, a ticker and a linked account are all things anyone can copy onto a mint of their own — what cannot be copied is this address. Where the metadata is immutable and content-addressed, the accounts below are the ones published at mint time; treat anything claiming to be this project from a different address as a different project.',
    explorerUrl: audit.explorerUrl,
  } satisfies TokenIdentity;
}

/**
 * What stands between buying a token and selling it again.
 *
 * Distinct from `mint_audit`, which answers "what powers exist over this
 * mint". This answers the narrower and more actionable question a buyer has:
 * *can I get out*. The same facts feed both, sorted differently — a live mint
 * authority is the headline for an audit and a footnote for an exit, because
 * dilution does not stop you selling.
 *
 * Read-only, and it stays that way. This builds nothing, signs nothing and
 * routes nothing; it reads a mint account and the largest holders and names
 * what it finds. Whether to act on it is the caller's, which is the only place
 * that decision can honestly live.
 */
export async function inspectExit(options: {
  mint: string;
  chain?: string;
}): Promise<TokenExitReport> {
  const chain = solanaChain(options.chain, 'Exit analysis');
  const mint = await toAddress(options.mint, chain);
  return inspectTokenExit(chain, mint);
}

/**
 * What one payment's receipt artwork looks like, and whether an image is it.
 *
 * Pure: it reads no chain and fetches nothing. The whole point of seeding the
 * art from the reference is that the picture is a function of a value already
 * on chain, so describing or checking it needs no network at all.
 *
 * Two questions, and the second is the one worth having. *What does this
 * payment look like* is useful for a preview. *Is this image the one this
 * reference generates* is how a holder finds out whether the picture a
 * marketplace is showing them is evidence of their payment or a picture
 * somebody swapped in — a receipt's metadata JSON is served by a host, and a
 * host can change its mind.
 *
 * A false `matches` is not proof of fraud. It means the image is not evidence,
 * which is a different and more useful thing to say.
 */
export async function receiptArt(options: {
  reference?: string;
  uri?: string;
  link?: string;
  image?: string;
}): Promise<{
  reference: string;
  source: 'reference' | 'uri';
  traits: { palette: string; modules: string; finders: string; fill: number };
  contrast: { inkOnPaper: number; accentOnPaper: number };
  svg?: string;
  matches?: boolean;
  note: string;
}> {
  const fromUri = options.uri ? referenceFromUri(options.uri) : null;
  const reference = options.reference ?? fromUri;

  if (!reference) {
    throw new SingularityError(
      'BAD_INPUT',
      options.uri
        ? 'That uri does not carry a reference, so the artwork cannot be derived from it. ' +
            'A Singularity receipt serves its JSON at <base>/<reference>.json; anything else means the ' +
            'reference is only in the off-chain JSON, which whoever serves it can change.'
        : 'Pass a reference, or a receipt uri that contains one.',
    );
  }

  const style = styleFor(reference);
  const traits = {
    palette: style.palette.name,
    modules: style.shape,
    finders: style.finder,
    fill: Math.round(style.fill * 100) / 100,
  };

  const contrast = {
    inkOnPaper: Math.round(contrastRatio(style.palette.ink, style.palette.paper) * 10) / 10,
    accentOnPaper: Math.round(contrastRatio(style.palette.accent, style.palette.paper) * 10) / 10,
  };

  // Rendering needs the link, because the art styles a matrix and the matrix is
  // the payment link. Without one the traits still answer "what does it look
  // like" — they are derived from the reference alone.
  const svg = options.link ? renderQrArt(qrMatrix(options.link), reference, { scale: 8 }) : undefined;

  if (options.image !== undefined) {
    if (!svg) {
      throw new SingularityError(
        'BAD_INPUT',
        'Checking an image needs the payment link too: the artwork styles the link\'s QR matrix, ' +
          'so without the link there is nothing to compare against.',
      );
    }

    const matches = svg === options.image;
    return {
      reference,
      source: options.reference ? 'reference' : 'uri',
      traits,
      contrast,
      svg,
      matches,
      note: matches
        ? 'This image is exactly what the reference generates, so it is evidence of that payment.'
        : 'This image is not what the reference generates. That does not prove the payment is bad — it means the image is not evidence of it, and whoever served it may have changed it.',
    };
  }

  return {
    reference,
    source: options.reference ? 'reference' : 'uri',
    traits,
    contrast,
    ...(svg ? { svg } : {}),
    note:
      'Derived from the reference alone, so anyone holding it gets this same answer without trusting a server. ' +
      (svg
        ? 'Pass `image` to check a served picture against it.'
        : 'Pass `link` to render the code, and `image` to check one.'),
  };
}

/**
 * Whether an invoice handed to you can be paid as stated.
 *
 * The counterpart to everything else in this file, which reads things the
 * caller chose to look at. This reads a demand *somebody else* wrote, and the
 * reason it belongs in a read-only client is that every check it makes is a
 * read — the facts that condemn a bad invoice are all sitting on chain, and the
 * only reason they go unchecked is that nothing in a signing flow looks.
 *
 * Addresses are passed through exactly as the demand stated them, without alias
 * resolution or normalisation. That is deliberate: the question is whether the
 * demand as received is payable, and a validator that quietly repairs its input
 * answers a different question than the one asked.
 */
export async function inspectPayment(options: {
  to?: string;
  tokenAccount?: string;
  mint?: string;
  token?: string;
  asset?: string;
  amount?: string;
  amountBaseUnits?: string;
  decimals?: number;
  memo?: string;
  reference?: string;
  expiresAt?: string;
  chain?: string;
}): Promise<PaymentDemandReport> {
  const { chain: named, ...demand } = options;
  const chain = getChain(named ?? 'solana');

  // Two readers, one set of rules. What a destination *is* differs completely
  // between the families — a token account that must already exist, against an
  // address that always does — so each family reads its own facts. Everything
  // about whether the demand is coherent with itself is shared, in
  // `pay/demand.ts`, because those questions do not change with the chain.
  if (chain.family === 'evm') return inspectEvmPaymentDemand(chain, demand);
  if (chain.family === 'svm') return inspectPaymentDemand(chain, demand);

  throw new SingularityError(
    'PAY_UNSUPPORTED',
    `Payment demands can be checked on EVM and Solana chains, and ${chain.name} is neither.`,
    'Bitcoin and Cosmos payments carry no token-contract layer to check a demand against, so there is nothing here that would not be guesswork.',
  );
}

/**
 * Check a demand, and build the payment only if it survives.
 *
 * One operation rather than two, because a check whose result the caller is
 * free to skip is a check nobody runs. Everything `inspect_payment` finds is
 * reported either way; what changes here is that `unpayable` stops being advice
 * and starts being a refusal — there is no transaction to sign at the end of
 * it. That is the same decision `build_burn` already made: refuse rather than
 * hand back something that cannot land.
 *
 * `unproven` refuses too. A demand that could not be checked is not a demand
 * that passed, and the whole point of building here rather than through
 * `build_transfer` is that the payload carries evidence it was checked.
 *
 * The warnings survive into the transaction. A signer reads `warnings`
 * immediately before signing and reads nothing else, so a finding that stayed
 * behind in the report would be a finding nobody sees at the moment it matters.
 *
 * It still signs nothing and sends nothing. The result is an unsigned payload
 * and the report that justified building it.
 */
export async function payDemand(options: {
  from: string;
  to?: string;
  tokenAccount?: string;
  mint?: string;
  token?: string;
  asset?: string;
  amount?: string;
  amountBaseUnits?: string;
  decimals?: number;
  memo?: string;
  reference?: string;
  expiresAt?: string;
  chain?: string;
  /**
   * Execute the built transaction against current state before returning it.
   *
   * On by default. Off is for a caller that has already simulated, or one that
   * would rather have a payload than an answer — and it is worth being explicit
   * that turning it off gives up the only check that catches a token delivering
   * less than it was sent.
   */
  simulate?: boolean;
}): Promise<{ report: PaymentDemandReport; transaction: UnsignedTx; simulation?: SimulationOutcome }> {
  const { from, simulate, ...demand } = options;
  const report = await inspectPayment(demand);

  if (report.verdict !== 'payable') {
    const fatal = report.findings.filter((f) => f.severity === 'fatal');
    throw new SingularityError(
      'DEMAND_REFUSED',
      report.note,
      fatal.length
        ? `Nothing was built. ${fatal.map((f) => `${f.code}: ${f.detail}`).join(' ')}`
        : 'Nothing was built, because the demand could not be checked against the chain. That is not the same as it being wrong — retry, or pass an endpoint that answers.',
    );
  }

  if (!report.destination || !demand.amount) {
    throw new SingularityError(
      'DEMAND_INCOMPLETE',
      'This demand checked out, and it does not say enough to build a payment from.',
      'A payment needs at least a payee and an amount. The demand supplied one or neither.',
    );
  }

  const chain = getChain(demand.chain ?? 'solana');
  const named = demand.token ?? demand.mint;

  if (chain.family === 'svm') {
    // Built through the payment path rather than the transfer path, because a
    // demand's `reference` is what makes the payment findable by the payee —
    // it is attached as a read-only account and is how the money is matched to
    // the order without the payer being trusted to quote anything.
    const built = await buildSolanaPayment(chain, {
      payer: from,
      to: demand.to ?? report.destination.owner ?? report.destination.address,
      amount: demand.amount,
      ...(named ? { mint: named } : {}),
      ...(demand.memo ? { memo: demand.memo } : {}),
      ...(demand.reference ? { references: [demand.reference] } : {}),
    });

    const outcome =
      simulate === false
        ? undefined
        : await simulateUnsigned(chain, {
            transaction: built.payload.transaction as string,
            destination: report.destination.address,
            ...(named ? { mint: named } : {}),
            expected: demand.amount,
          }).catch(() => undefined);

    return finish(report, built, outcome);
  }

  const built = await buildTransfer({
    chain: chain.id,
    from,
    to: report.destination.address,
    amount: demand.amount,
    ...(named ? { token: named } : {}),
  });

  const outcome =
    simulate === false
      ? undefined
      : await simulateUnsignedEvm(chain, {
          from,
          to: built.payload.to as string,
          ...(built.payload.data ? { data: built.payload.data as string } : {}),
          ...(built.payload.value ? { value: built.payload.value as string } : {}),
          destination: report.destination.address,
          ...(named ? { token: named } : {}),
          expected: demand.amount,
        }).catch(() => undefined);

  return finish(report, built, outcome);
}

/**
 * Refuse a transaction that does not execute, and carry what was measured into
 * the one that does.
 *
 * `build_payment` already refuses a demand whose facts do not check out. A
 * transaction that reverts against current state is the same refusal arriving
 * one step later: there is no version of handing that back which helps, since
 * signing it spends a fee to fail.
 *
 * A shortfall is different and is not a refusal. The transaction executes and
 * the payee is credited less than the demand asked for, which may be exactly
 * what both parties expect of a fee-bearing token — so it becomes a warning on
 * the payload, where a signer reads it.
 */
function finish(
  report: PaymentDemandReport,
  built: UnsignedTx,
  simulation: SimulationOutcome | undefined,
): { report: PaymentDemandReport; transaction: UnsignedTx; simulation?: SimulationOutcome } {
  if (simulation && !simulation.succeeded) {
    throw new SingularityError(
      'DEMAND_DOES_NOT_EXECUTE',
      simulation.note,
      'Nothing was built. The demand checked out against the chain as facts, and the transaction it produces does not execute against the chain as it is right now.',
    );
  }

  const carried = withDemandWarnings(built, report);

  if (simulation?.shortfall) {
    carried.warnings.push(`DELIVERS_LESS_THAN_ASKED: ${simulation.note}`);
  } else if (simulation?.delivered) {
    carried.warnings.push(
      `Simulated against current state: delivers ${simulation.delivered.formatted} ${simulation.delivered.symbol} to ${report.destination?.address ?? 'the recipient'}.`,
    );
  } else if (simulation) {
    carried.warnings.push(`Not simulated to a measured delivery: ${simulation.completeness.note}`);
  }

  return { report, transaction: carried, ...(simulation ? { simulation } : {}) };
}

/**
 * Carry the check into the thing that gets signed.
 *
 * `warnings` is the last text a signer reads. A demand that was accepted with
 * reservations — a fee-bearing mint, a contract payee, a memo the chain cannot
 * carry — has to say so here, not only in a report the signing step never sees.
 */
function withDemandWarnings(tx: UnsignedTx, report: PaymentDemandReport): UnsignedTx {
  const carried = report.findings
    .filter((f) => f.severity === 'warning')
    .map((f) => `${f.code}: ${f.detail}`);

  return {
    ...tx,
    warnings: [
      ...tx.warnings,
      ...carried,
      `This demand was checked against ${report.chain} before building: ${report.note}`,
    ],
  };
}
