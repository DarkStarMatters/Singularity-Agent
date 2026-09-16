import { adapterFor } from '../adapters/index.js';
import { allChains, getChain, portfolioChains, resolveAlias } from '../core/registry.js';
import { detect } from '../core/detect.js';
import { SingularityError } from '../core/errors.js';
import { decodeCalldata, decodeWithAbi } from '../core/abi.js';
import { explorerUrl, shortAddress } from '../core/format.js';
import { convertBech32Prefix } from '../core/address-codec.js';
import type { StateOptions, TransferParams } from '../core/adapter.js';
import { completeness, weakest, type Completeness } from '../core/envelope.js';
import type {
  BalanceEntry,
  ChainSpec,
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
 * Work out what an arbitrary string is, resolving names to addresses where we can.
 */
export async function resolve(input: string, chainHint?: string): Promise<ResolvedIdentity> {
  const raw = resolveAlias(input.trim());
  const detection = detect(raw);

  const base: ResolvedIdentity = {
    input,
    kind: detection.kind,
    chains: chainHint ? [getChain(chainHint).id] : detection.chains,
    family: detection.families[0],
    note: detection.reason,
  };

  if (detection.kind === 'address') {
    base.address = raw;

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
        base.note = `${detection.reason} Primary ENS name: ${name}.`;
      }
    }
    return base;
  }

  if (detection.kind === 'name') {
    const chain = getChain(chainHint ?? detection.chains[0] ?? 'ethereum');
    const adapter = adapterFor(chain);

    if (!adapter.resolveName) {
      return { ...base, note: `${detection.reason} No name resolver is wired up for ${chain.name}.` };
    }

    // No catch here: an RPC failure must surface as an RPC failure, not be
    // reported back to the user as "that name does not exist".
    const address = await adapter.resolveName(chain, raw);
    if (!address) {
      return {
        ...base,
        name: raw,
        note: `${detection.reason} The name did not resolve — it may be unregistered or have no address record set.`,
      };
    }
    return { ...base, address, name: raw };
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

export async function getBalance(options: {
  address: string;
  chain: string;
  tokens?: string[];
  includeTokens?: boolean;
  atBlock?: string | number;
}): Promise<BalanceResult> {
  const chain = getChain(options.chain);
  const adapter = adapterFor(chain);
  const address = await toAddress(options.address, chain);

  const atBlock = parseAtBlock(options.atBlock);
  const state: StateOptions | undefined = atBlock === undefined ? undefined : { atBlock };

  const native = await adapter.getNativeBalance(chain, address, state);

  let tokens: BalanceEntry[] = [];
  let tokenCompleteness = completeness.curated(
    'Token balances were not requested, so none were checked.',
  );

  if (options.includeTokens !== false) {
    try {
      const scan = await adapter.getTokenBalances(chain, address, options.tokens, state);
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

export interface PortfolioResult {
  address: string;
  chainsQueried: string[];
  balances: BalanceResult[];
  errors: Array<{ chain: string; error: string; hint?: string }>;
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
 * Query one address across many chains at once.
 *
 * Chains are filtered to those the address format is actually valid on, so an
 * EVM address does not produce twenty Solana errors.
 */
export async function getPortfolio(options: {
  address: string;
  chains?: string[];
  includeTokens?: boolean;
}): Promise<PortfolioResult> {
  const raw = resolveAlias(options.address.trim());
  const requested = options.chains?.length ? options.chains : portfolioChains();

  // A name has to become an address before any chain can be asked about it —
  // otherwise every chain rejects the name and the whole call looks unsupported.
  const detection = detect(raw);
  let address = raw;

  if (detection.kind === 'name') {
    const nameChain = getChain(detection.chains[0] ?? 'ethereum');
    const resolved = await adapterFor(nameChain).resolveName?.(nameChain, raw);
    if (!resolved) {
      throw new SingularityError(
        'NAME_NOT_RESOLVED',
        `"${raw}" did not resolve to an address.`,
        'The name may be unregistered, expired, or have no address record set.',
      );
    }
    address = resolved;
  }

  const candidates = requested
    .map((id) => getChain(id))
    .filter((chain) => adapterFor(chain).isValidAddress(chain, address));

  if (!candidates.length) {
    const resolvedDetection = detect(address);
    throw new SingularityError(
      'NO_MATCHING_CHAINS',
      `"${shortAddress(address, 10, 6)}" is not a valid address on any of: ${requested.join(', ')}.`,
      resolvedDetection.chains.length
        ? `That address works on: ${resolvedDetection.chains.slice(0, 6).join(', ')}. Pass those as \`chains\`.`
        : resolvedDetection.reason,
    );
  }

  const settled = await Promise.allSettled(
    candidates.map((chain) =>
      getBalance({ address, chain: chain.id, includeTokens: options.includeTokens }),
    ),
  );

  const balances: BalanceResult[] = [];
  const errors: PortfolioResult['errors'] = [];

  settled.forEach((result, index) => {
    const chain = candidates[index]!;
    if (result.status === 'fulfilled') {
      balances.push(result.value);
      return;
    }
    const err = result.reason;
    errors.push({
      chain: chain.id,
      error: err instanceof Error ? err.message : String(err),
      hint: err instanceof SingularityError ? err.hint : undefined,
    });
  });

  const combined =
    weakest([
      ...balances.map((b) => b.tokenCompleteness),
      ...errors.map((e) => completeness.failed(`${e.chain}: ${e.error}`)),
    ]) ?? completeness.failed('No chain answered.');

  return {
    address,
    chainsQueried: candidates.map((c) => c.id),
    balances,
    errors,
    completeness: combined,
    note: 'Balances only — no fiat pricing. Chains where the address format does not apply were skipped, not queried and failed.',
  };
}

/**
 * Fetch a transaction. Without a chain hint, search the chains the hash format
 * allows, in parallel, and report every chain it was found on.
 */
export async function getTransaction(options: {
  hash: string;
  chain?: string;
}): Promise<{ found: NormalizedTx[]; searched: string[]; note?: string }> {
  const hash = options.hash.trim();

  if (options.chain) {
    const chain = getChain(options.chain);
    const tx = await adapterFor(chain).getTransaction(chain, hash);
    return { found: [tx], searched: [chain.id] };
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

  const found = settled
    .filter((r): r is PromiseFulfilledResult<NormalizedTx> => r.status === 'fulfilled')
    .map((r) => r.value);

  if (!found.length) {
    throw new SingularityError(
      'TX_NOT_FOUND',
      `Transaction ${shortAddress(hash, 12, 8)} was not found on any of: ${candidates.map((c) => c.id).join(', ')}.`,
      'Pass `chain` explicitly if it is on a chain outside the default search set, or the transaction may not exist.',
    );
  }

  return {
    found,
    searched: candidates.map((c) => c.id),
    note:
      found.length > 1
        ? 'This hash exists on more than one chain. That is normal for deterministic deployments and replayed transactions — check the chain field on each.'
        : undefined,
  };
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
  return adapterFor(chain).getBlock(chain, options.ref ?? 'latest');
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

export function decode(data: string, abi?: string[]): DecodedCall {
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
  return decodeCalldata(data);
}

/** Accept a name, an address-book alias, or a raw address; always return an address. */
async function toAddress(input: string, chain: ChainSpec): Promise<string> {
  const raw = resolveAlias(input.trim());
  const adapter = adapterFor(chain);

  if (adapter.isValidAddress(chain, raw)) return raw;

  if (raw.includes('.') && adapter.resolveName) {
    const resolved = await adapter.resolveName(chain, raw);
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
