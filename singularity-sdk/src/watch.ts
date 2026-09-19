/**
 * The typed watches an application uses.
 *
 * The loop itself is not here. It lives in the agent core, in
 * `src/core/watch.ts`, because `singularity watch` on the CLI needs the same
 * one and the dependency only runs one way — the SDK depends on the agent,
 * never the reverse. Two loops would be two sets of backoff semantics, and the
 * one that gets fixed is whichever one somebody happened to be looking at.
 *
 * Read the note at the top of that file before relying on any of this. The
 * short version: **these are polling loops, not subscriptions.** A poll reports
 * the state at the times it asked, which is a strictly weaker claim than
 * everything that happened, and a value that changed and changed back between
 * two ticks is a value this never saw.
 *
 * What is here is the part that differs per watch: *what counts as a change*.
 * That is the interesting decision, and it is genuinely different each time — a
 * block number is the whole answer for a chain tip and irrelevant for a
 * balance, where a re-worded completeness note must not read as money moving.
 */

import { balanceIdentity as identityOfBalance, operations, pollLoop } from 'singularity-agent';
import type { Change, Handler, Subscription, WatchOptions } from 'singularity-agent';
import type {
  BalanceResult,
  ChainLiveness,
  NormalizedBlock,
  NormalizedTx,
} from './types.js';
import { withRetry, type RetryPolicy } from './cache.js';
import { SdkError } from './errors.js';

// Re-exported so an application has one import site, and so the loop's own
// documentation stays reachable from the types it hands back.
export type { Change, Handler, Subscription, WatchOptions };

export interface WatchApi {
  /**
   * Native and token balances for an address.
   *
   * Fires when the rendered balance changes. Compares the native amount and the
   * token amounts, *not* the whole result object — that carries an explorer URL
   * and a completeness note, and comparing those would fire this handler on
   * cosmetic churn.
   *
   * The completeness envelope rides through untouched. A `curated` token scan
   * that gains an entry means a curated token moved; it does not mean the
   * wallet's holdings are now fully known.
   */
  balance(
    options: { address: string; chain?: string; includeTokens?: boolean; tokens?: string[] },
    handler: Handler<BalanceResult>,
    watch?: WatchOptions,
  ): Subscription;

  /**
   * The head of a chain.
   *
   * Fires on every new height. Heights can arrive out of order across a reorg,
   * and the handler sees what the endpoint reported — including a height lower
   * than the one before it, because hiding that would hide the reorg.
   */
  tip(chain: string | undefined, handler: Handler<NormalizedBlock>, watch?: WatchOptions): Subscription;

  /**
   * One transaction, until it reaches the confirmation depth you asked for.
   *
   * Fires on every change to its status or finality, then stops on its own —
   * this is the one watch with a natural end. A transaction that never appears
   * keeps polling and is not an error, because "not mined yet" and "never will
   * be" are indistinguishable from here.
   */
  transaction(
    options: { hash: string; chain?: string; confirmations?: number },
    handler: Handler<NormalizedTx>,
    watch?: WatchOptions,
  ): Subscription;

  /**
   * Chain health, for a monitor.
   *
   * Fires when any chain's status changes. Never cached anywhere in this SDK —
   * see the rule in `cache.ts`.
   */
  liveness(chains: string[] | undefined, handler: Handler<ChainLiveness[]>, watch?: WatchOptions): Subscription;
}

interface WatchDeps {
  cache: false;
  retry: RetryPolicy;
  defaultChain?: string;
}

export function createWatch(deps: WatchDeps): WatchApi {
  const chainOf = (chain?: string): string => {
    const id = chain ?? deps.defaultChain;
    if (!id) {
      throw new SdkError(
        'NO_CHAIN',
        'No chain given and no default configured.',
        'Pass `chain`, or set `chain` on createSingularity().',
      );
    }
    return id;
  };

  const read = <T>(work: () => Promise<T>): Promise<T> => withRetry(deps.retry, work);

  /** The fallback error log names which watch failed, not just that one did. */
  const labelled = (what: string, watch: WatchOptions) => ({
    ...watch,
    label: `singularity-sdk ${what}`,
  });

  return {
    balance(options, handler, watch = {}) {
      const chain = chainOf(options.chain);
      return pollLoop(
        () => read(() => operations.getBalance({ ...options, chain })),
        identityOfBalance,
        handler,
        labelled('balance', watch),
      );
    },

    tip(chain, handler, watch = {}) {
      const id = chainOf(chain);
      return pollLoop(
        () => read(() => operations.getBlock({ chain: id })),
        (block) => String(block.number),
        handler,
        labelled('tip', watch),
      );
    },

    transaction(options, handler, watch = {}) {
      const target = options.confirmations ?? 1;
      let settled = false;

      return pollLoop(
        async () => {
          const result = await read(() => operations.getTransaction(options));
          const tx = result.found[0];
          if (!tx) return undefined; // Not mined yet. Not a change, not an error.
          if ((tx.finality?.confirmations ?? 0) >= target) settled = true;
          return tx;
        },
        (tx) => `${tx.status}|${tx.finality?.confirmations ?? 0}|${tx.finality?.kind ?? ''}`,
        handler,
        { ...labelled('transaction', watch), until: () => settled },
      );
    },

    liveness(chains, handler, watch = {}) {
      return pollLoop(
        () => operations.checkLiveness(chains),
        (all) => all.map((c) => `${c.chain}:${c.status}`).join(','),
        handler,
        labelled('liveness', watch),
      );
    },
  };
}

/**
 * What makes two balance readings the same balance.
 *
 * Re-exported rather than defined here. The rule lives beside `BalanceResult`
 * in the agent core, because `singularity watch balance` needs exactly the same
 * one and a second copy would drift *silently* — a watch comparing slightly
 * different fields does not fail, it just reports the wrong set of changes.
 *
 * Worth having on the export surface because an application writing its own
 * loop over `sdk.balance` wants this rule and getting it wrong is invisible in
 * both directions: too loose and the handler never fires, too tight and it
 * fires every time a completeness note is re-worded.
 */
export { balanceIdentity } from 'singularity-agent';
