/**
 * The typed client.
 *
 * Everything here is the agent's own operations with three things added:
 * configured defaults so a single-chain application stops repeating itself, a
 * cache that only holds what is safe to hold, and retry on the failures worth
 * another attempt. Nothing is reimplemented — a balance read through this
 * client and a balance read through `singularity balance` go down the same code
 * path and carry the same completeness envelope.
 *
 * The surface is split in three, deliberately:
 *
 * - **reads**, on the client itself. Always available.
 * - **`build`** — unsigned payloads. Always available, signer or not. Building
 *   is a read that returns bytes.
 * - **`write`** — build, sign, send. Exists only when a signer was supplied,
 *   and the type system says so at compile time rather than the network saying
 *   so at runtime.
 */

import { getChain, operations } from 'singularity-agent';
import type {
  BalanceResult,
  BurnClaim,
  ChainLiveness,
  ChainSummary,
  DecodedCall,
  EndpointHealthResult,
  FeeEstimate,
  MintAudit,
  NormalizedBlock,
  NormalizedTx,
  PortfolioResult,
  ResolvedIdentity,
  ResponseBudget,
  TokenExitReport,
  TokenIdentity,
  TransactionHistory,
  UnsignedTx,
} from './types.js';
import { ReadCache, cacheKey, withRetry, type CacheClass, type CacheStats } from './cache.js';
import { resolveConfig, type ResolvedConfig, type SingularityConfig } from './config.js';
import { SdkError } from './errors.js';
import { SIGNER_REQUIRED, isSigner, type SignedTx, type Signer, type SignerRequired } from './signer.js';
import { createWatch, type WatchApi } from './watch.js';

/** What a write returns. */
export interface WriteReceipt {
  /** What was built, before anyone signed it. Kept for the audit trail. */
  unsigned: UnsignedTx;
  /** What the signer produced. */
  signed: SignedTx;
  /**
   * The hash it landed under — present only when the signer broadcast it.
   *
   * Absent means signed-but-not-sent, which is a legitimate outcome for a
   * signer with no `send`, not a failure and not something to retry. Read
   * {@link WriteReceipt.broadcast} rather than inferring from this: a receipt
   * with no hash is bytes on your disk, and treating it as a sent transaction
   * is how an application double-spends on its next attempt.
   */
  hash?: string;
  /** True when this went to a network. False when it was only signed. */
  broadcast: boolean;
}

/** Writes, once a signer exists. */
export interface WriteApi {
  /** Build a transfer, sign it, and send it if the signer can. */
  transfer(params: {
    to: string;
    amount: string;
    chain?: string;
    from?: string;
    token?: string;
    memo?: string;
  }): Promise<WriteReceipt>;

  /**
   * Build a Solana burn, sign it, and send it if the signer can.
   *
   * `owner` defaults to the signer's own address on that chain, which is the
   * only value that can work — a burn spends from a token account the signer
   * must control.
   */
  burn(params: {
    mint: string;
    amount: string;
    owner?: string;
    memo?: string;
    chain?: string;
  }): Promise<WriteReceipt>;

  /**
   * Sign and send something already built.
   *
   * The escape hatch for a payload this SDK has no builder for, and the honest
   * way to put a human in the loop: `build` it, show them, then hand it here.
   */
  submit(unsigned: UnsignedTx, chain?: string): Promise<WriteReceipt>;

  /** The address this client writes from, on a given chain. */
  address(chain?: string): Promise<string>;
}

/** Unsigned payloads. Available with or without a signer. */
export interface BuildApi {
  transfer(params: {
    to: string;
    amount: string;
    chain?: string;
    from?: string;
    token?: string;
    memo?: string;
  }): Promise<UnsignedTx>;
  burn(params: {
    mint: string;
    amount: string;
    owner: string;
    memo?: string;
    chain?: string;
  }): Promise<UnsignedTx>;
}

/**
 * A Singularity client.
 *
 * The `S` parameter carries whether a signer was supplied, and that is the only
 * reason it exists: it turns `sdk.write` into a compile error on a read-only
 * client, so "did you configure custody" is answered by `tsc` rather than by a
 * network.
 */
export interface Singularity<S extends Signer | undefined = undefined> {
  // ── chains and identity ────────────────────────────────────────────────
  chains(query?: string, family?: string): ChainSummary[];
  resolve(input: string, chainHint?: string): Promise<ResolvedIdentity>;

  // ── state ──────────────────────────────────────────────────────────────
  balance(options: {
    address: string;
    chain?: string;
    tokens?: string[];
    includeTokens?: boolean;
    atBlock?: string | number;
    budget?: ResponseBudget;
  }): Promise<BalanceResult>;

  portfolio(options: {
    address: string;
    chains?: string[];
    includeTokens?: boolean;
    budget?: ResponseBudget;
  }): Promise<PortfolioResult>;

  history(options: {
    address: string;
    chain?: string;
    limit?: number;
    cursor?: string;
    budget?: ResponseBudget;
  }): Promise<TransactionHistory>;

  transaction(options: {
    hash: string;
    chain?: string;
  }): Promise<{ found: NormalizedTx[]; searched: string[]; note?: string }>;

  block(options?: { chain?: string; ref?: string | number }): Promise<NormalizedBlock>;
  fees(chain?: string): Promise<FeeEstimate>;

  readContract(options: {
    address: string;
    chain?: string;
    method?: string;
    abi?: string;
    args?: unknown[];
    atBlock?: string | number;
  }): Promise<unknown>;

  decode(data: string, abi?: string[], lookup?: boolean): Promise<DecodedCall>;

  // ── tokens ─────────────────────────────────────────────────────────────
  mintAudit(options: { mint: string; chain?: string }): Promise<MintAudit>;
  /**
   * Before buying: what could stop you selling this again.
   *
   * Names mechanisms rather than scoring the token — a transfer hook, a
   * permanent delegate, a live freeze authority — and says who holds each one.
   * Read `canExit` and `underThirdPartyControl` together: they are different
   * questions, and a token can be freely sellable while a named party retains
   * the power to stop you.
   *
   * Never cached. It is the check standing between somebody and spending
   * money, and a stale answer about a mint whose authority just changed is the
   * one that costs them.
   */
  inspectExit(options: { mint: string; chain?: string }): Promise<TokenExitReport>;
  tokenIdentity(options: { mint: string; chain?: string; fetch?: boolean }): Promise<TokenIdentity>;
  verifyBurn(options: {
    signature: string;
    chain?: string;
    mint?: string;
    owner?: string;
    minimum?: string;
    expectMemo?: string;
  }): Promise<BurnClaim>;

  // ── operations ─────────────────────────────────────────────────────────
  liveness(chains?: string[]): Promise<ChainLiveness[]>;
  endpoints(chains?: string[]): Promise<EndpointHealthResult[]>;

  // ── payloads ───────────────────────────────────────────────────────────
  build: BuildApi;

  /**
   * Writes. `SignerRequired` when no signer was configured, so
   * `sdk.write.transfer(…)` fails to compile with a message naming its own fix.
   */
  write: S extends Signer ? WriteApi : SignerRequired;

  /** Polling subscriptions. See `watch.ts` for what a poll does and does not see. */
  watch: WatchApi;

  /** Cache hit rate, for deciding whether the TTLs are earning their keep. */
  cacheStats(): CacheStats;
  clearCache(): void;

  /** The configuration in effect, after defaults. */
  readonly config: Readonly<ResolvedConfig>;
}

/**
 * Create a client.
 *
 * Passing a `signer` widens the return type so `write` becomes callable.
 */
export function createSingularity<const C extends SingularityConfig>(
  config?: C,
): Singularity<C extends { signer: Signer } ? Signer : undefined> {
  const resolved = resolveConfig(config);
  const cache = new ReadCache(resolved.ttl);
  const retry = <T>(work: () => Promise<T>): Promise<T> => withRetry(resolved.retry, work);

  /** The chain for a call: explicit, then the client default, then an error. */
  const pick = (chain?: string): string => {
    const id = chain ?? resolved.chain;
    if (!id) {
      throw new SdkError(
        'NO_CHAIN',
        'No chain given and no default configured.',
        'Pass `chain` on the call, or `chain` to createSingularity().',
      );
    }
    return id;
  };

  const budgeted = <T extends { budget?: ResponseBudget }>(options: T): T =>
    options.budget !== undefined || resolved.budget === undefined
      ? options
      : { ...options, budget: resolved.budget };

  /** Pinned to a height means immutable; otherwise it is stale on arrival. */
  const stateClass = (atBlock: unknown): CacheClass =>
    atBlock === undefined || atBlock === null ? 'current' : 'historical';

  const build: BuildApi = {
    async transfer(params) {
      const chain = pick(params.chain);
      return retry(() => operations.buildTransfer({ ...params, chain }));
    },
    async burn(params) {
      return retry(() =>
        operations.buildBurn({ ...params, ...(params.chain ? { chain: params.chain } : {}) }),
      );
    },
  };

  const client: Singularity<Signer | undefined> = {
    config: Object.freeze(resolved),

    chains(query, family) {
      return operations.listChains(query, family);
    },

    async resolve(input, chainHint) {
      return cache.through('metadata', cacheKey('resolve', { input, chainHint }), () =>
        retry(() => operations.resolve(input, chainHint)),
      );
    },

    async balance(options) {
      const args = budgeted({ ...options, chain: pick(options.chain) });
      return cache.through(stateClass(options.atBlock), cacheKey('balance', args), () =>
        retry(() => operations.getBalance(args)),
      );
    },

    async portfolio(options) {
      const chains = options.chains ?? resolved.portfolioChains;
      const args = budgeted({ ...options, ...(chains ? { chains } : {}) });
      return cache.through('current', cacheKey('portfolio', args), () =>
        retry(() => operations.getPortfolio(args)),
      );
    },

    async history(options) {
      const args = budgeted({ ...options, chain: pick(options.chain) });
      return cache.through('current', cacheKey('history', args), () =>
        retry(() => operations.getHistory(args)),
      );
    },

    async transaction(options) {
      // A mined transaction does not change, but its confirmation count does,
      // and the count is what a caller decides on. So: `current`.
      return cache.through('current', cacheKey('transaction', options), () =>
        retry(() => operations.getTransaction(options)),
      );
    },

    async block(options = {}) {
      const args = { ...options, chain: pick(options.chain) };
      // A numbered block is immutable; `latest` is a moving target, and must
      // never be served from the long-lived historical bucket.
      const cls: CacheClass = args.ref === undefined || args.ref === 'latest' ? 'current' : 'historical';
      return cache.through(cls, cacheKey('block', args), () => retry(() => operations.getBlock(args)));
    },

    async fees(chain) {
      const id = pick(chain);
      return cache.through('current', cacheKey('fees', { chain: id }), () =>
        retry(() => operations.getFees(id)),
      );
    },

    async readContract(options) {
      const args = { ...options, chain: pick(options.chain) };
      return cache.through(stateClass(options.atBlock), cacheKey('readContract', args), () =>
        retry(() => operations.readContract(args)),
      );
    },

    async decode(data, abi, lookup) {
      return cache.through('metadata', cacheKey('decode', { data, abi, lookup }), () =>
        operations.decode(data, abi, lookup),
      );
    },

    async mintAudit(options) {
      return cache.through('current', cacheKey('mintAudit', options), () =>
        retry(() => operations.auditMint(options)),
      );
    },

    // Never cached, for the same reason `verifyBurn` is not: this is the check
    // standing between somebody and spending money, and a mint's authorities
    // can change between one call and the next.
    async inspectExit(options) {
      return retry(() => operations.inspectExit(options));
    },

    async tokenIdentity(options) {
      return cache.through('current', cacheKey('tokenIdentity', options), () =>
        retry(() => operations.tokenIdentity(options)),
      );
    },

    async verifyBurn(options) {
      // Never cached. A verify is the check standing between a burn and
      // whatever it entitles someone to, and a cached answer is a replay
      // window — see `cache.ts` for the rule this follows.
      return retry(() => operations.verifyBurn(options));
    },

    // Never cached, at any TTL: a cached liveness result is indistinguishable
    // from the outage it exists to report.
    async liveness(chains) {
      return operations.checkLiveness(chains);
    },

    async endpoints(chains) {
      return operations.checkEndpoints(chains);
    },

    build,
    write: (resolved.signer ? makeWrite(resolved.signer, build, pick) : SIGNER_REQUIRED) as WriteApi,
    watch: createWatch({
      cache: false,
      retry: resolved.retry,
      ...(resolved.chain ? { defaultChain: resolved.chain } : {}),
    }),

    cacheStats: () => cache.stats(),
    clearCache: () => cache.clear(),
  };

  return client as Singularity<C extends { signer: Signer } ? Signer : undefined>;
}

/**
 * The build → sign → send pipeline.
 *
 * Three checks stand between a built payload and a broadcast, and each one
 * exists because the failure it catches is otherwise silent:
 *
 * 1. **Family**, before anything is built. An EVM-only signer asked for a
 *    Solana burn fails on the first line naming both families, rather than
 *    somewhere inside an encoder.
 * 2. **Chain**, after signing. The signer's `SignedTx.chain` must match what
 *    was built. A signer that quietly signs for mainnet what was built for a
 *    testnet is the worst thing that can happen in this file, and it is a bug
 *    class that produces a perfectly valid transaction.
 * 3. **Broadcast capability.** A signer with no `send` says so by returning
 *    `broadcast: false`, rather than a receipt with no hash that reads like
 *    success.
 */
function makeWrite(signer: Signer, build: BuildApi, pick: (chain?: string) => string): WriteApi {
  const guard = (chainId: string) => {
    const chain = getChain(chainId);
    if (!signer.families.includes(chain.family)) {
      throw new SdkError(
        'SIGNER_WRONG_FAMILY',
        `The configured signer handles ${signer.families.join(', ')}, and ${chain.name} is ${chain.family}.`,
        'Configure a signer for this family, or route this chain through a separate client.',
      );
    }
    return chain;
  };

  const run = async (chainId: string, unsigned: UnsignedTx): Promise<WriteReceipt> => {
    const chain = guard(chainId);
    const signed = await signer.sign(unsigned, chain);

    if (signed.chain !== chain.id) {
      throw new SdkError(
        'SIGNER_CHAIN_MISMATCH',
        `Built for ${chain.id}, but the signer returned a transaction for ${signed.chain}. Nothing was broadcast.`,
        'This is a bug in the signer. The transaction is signed and in hand; inspect it before doing anything with it.',
      );
    }

    if (!signer.send) {
      return { unsigned, signed, broadcast: false };
    }

    const hash = await signer.send(signed, chain);
    return { unsigned, signed, hash, broadcast: true };
  };

  return {
    async transfer(params) {
      const chain = pick(params.chain);
      guard(chain);
      return run(chain, await build.transfer({ ...params, chain }));
    },

    async burn(params) {
      const chain = params.chain ?? 'solana';
      const spec = guard(chain);
      const owner = params.owner ?? (await signer.address(spec));
      return run(chain, await build.burn({ ...params, owner, chain }));
    },

    async submit(unsigned, chain) {
      return run(chain ?? unsigned.chain ?? pick(), unsigned);
    },

    address(chain) {
      return signer.address(getChain(pick(chain)));
    },
  };
}

/**
 * Runtime gate, for callers who get no compile-time one.
 *
 * The conditional type on `write` is invisible to plain JavaScript, and to
 * TypeScript that has widened the client to `Singularity<Signer | undefined>`
 * along the way. This narrows it back and raises a readable error where it
 * cannot.
 */
export function assertWritable(
  sdk: Singularity<Signer | undefined>,
): asserts sdk is Singularity<Signer> {
  if (!isSigner(sdk.config.signer)) {
    throw new SdkError(
      'NO_SIGNER',
      'This client was created without a signer, so it cannot sign or send.',
      'Pass `signer` to createSingularity(). This SDK ships no signer implementation and holds no keys — supply one backed by your wallet, KMS or hardware device.',
    );
  }
}
