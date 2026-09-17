import { adapterFor } from '../adapters/index.js';
import {
  auditMint as auditSolanaMint,
  buildBurn as buildSolanaBurn,
  verifyBurn as verifySolanaBurn,
} from '../adapters/solana.js';
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
import { lookupAlias, type AliasTarget } from '../core/address-book.js';
import { detect } from '../core/detect.js';
import { SingularityError } from '../core/errors.js';
import { decodeCalldata, decodeWithAbi } from '../core/abi.js';
import { lookupSelector } from '../core/selectors.js';
import { explorerUrl, parseUnits, shortAddress } from '../core/format.js';
import { convertBech32Prefix } from '../core/address-codec.js';
import type { StateOptions, TransferParams } from '../core/adapter.js';
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
  const lookup = lookupAlias(options.address);
  const raw = lookup.target;
  const requested = options.chains?.length ? options.chains : portfolioChains();

  // A name has to become an address before any chain can be asked about it —
  // otherwise every chain rejects the name and the whole call looks unsupported.
  const detection = detect(raw);
  let address: string;

  if (detection.kind === 'name') {
    const nameChain = getChain(detection.chains[0] ?? 'ethereum');
    const resolved = lookup.settle(
      (await adapterFor(nameChain).resolveName?.(nameChain, raw)) ?? null,
    );
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

  return buildSolanaBurn(chain, { owner, mint, amount: options.amount });
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
  options: { mint?: string; owner?: string; minimum?: string },
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

  return { mint, owner, minimum };
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
