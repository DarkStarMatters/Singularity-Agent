/**
 * Client configuration, and the one place it is not purely local.
 */

import { resetRegistry } from 'singularity-agent';
import type { ResponseBudget } from './types.js';
import { DEFAULT_RETRY, DEFAULT_TTL, type CacheTtl, type RetryPolicy } from './cache.js';
import type { Signer } from './signer.js';

export interface SingularityConfig {
  /**
   * The chain to use when a call does not name one. Without it, every read
   * takes an explicit `chain` — which is correct for a tool and tedious for an
   * application that only ever touches one network.
   */
  chain?: string;

  /**
   * Default response budget for every list-shaped read. A dashboard rendering
   * eight rows should say `{ maxItems: 8 }` once here rather than on every
   * call, and get an honest `truncated` envelope back instead of a silent cut.
   */
  budget?: ResponseBudget;

  /**
   * Chains to sweep when `portfolio` is called without a list.
   */
  portfolioChains?: string[];

  /**
   * Endpoint overrides, by chain id: `{ ethereum: 'https://…' }`.
   *
   * Applied by setting the `SINGULARITY_RPC_*` variables the core already
   * reads, then resetting its registry — which makes this **process-global**,
   * not per-client. Two clients in one process configured with different
   * endpoints for the same chain will not each get their own; the last one
   * constructed wins for both.
   *
   * That is a real limitation and it is written here rather than discovered:
   * the chain registry is module state in the agent core, and giving each
   * client a private one is a change to that package, not something this SDK
   * can fake convincingly. For the common case — one process, one
   * configuration — it does exactly what it looks like it does. For the
   * uncommon one, run two processes, or set the environment yourself and leave
   * this unset.
   */
  rpc?: Record<string, string>;

  /** How long reads stay cached, by class. See {@link CacheTtl}. */
  cache?: Partial<CacheTtl> | false;

  /** Transient-failure retry. `false` disables it. */
  retry?: Partial<RetryPolicy> | false;

  /**
   * Where writes go. Omit it and the client is read-only, and `sdk.write` is a
   * compile error rather than a runtime surprise. This SDK ships no
   * implementation — see `src/signer.ts`.
   */
  signer?: Signer;
}

export interface ResolvedConfig {
  chain?: string;
  budget?: ResponseBudget;
  portfolioChains?: string[];
  ttl: CacheTtl;
  retry: RetryPolicy;
  signer?: Signer;
}

export function resolveConfig(config: SingularityConfig = {}): ResolvedConfig {
  if (config.rpc && Object.keys(config.rpc).length > 0) {
    for (const [chain, url] of Object.entries(config.rpc)) {
      process.env[`SINGULARITY_RPC_${chain.toUpperCase().replace(/-/g, '_')}`] = url;
    }
    // The registry caches its chain list on first read; without this the
    // overrides apply to whichever clients happen to be constructed before
    // anything asks for a chain, which is the kind of ordering dependency that
    // works locally and fails under a warm serverless container.
    resetRegistry();
  }

  return {
    ...(config.chain !== undefined ? { chain: config.chain } : {}),
    ...(config.budget !== undefined ? { budget: config.budget } : {}),
    ...(config.portfolioChains !== undefined ? { portfolioChains: config.portfolioChains } : {}),
    ttl: config.cache === false ? { historical: 0, current: 0, metadata: 0 } : { ...DEFAULT_TTL, ...config.cache },
    retry: config.retry === false ? { ...DEFAULT_RETRY, attempts: 1 } : { ...DEFAULT_RETRY, ...config.retry },
    ...(config.signer !== undefined ? { signer: config.signer } : {}),
  };
}
