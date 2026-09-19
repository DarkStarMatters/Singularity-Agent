/**
 * Watching a chain, without pretending to be subscribed to one.
 *
 * Roadmap 4.3 has said "watch mode" since v0.0.3 and it has stayed unshipped,
 * because the honest version is less impressive than the word suggests. These
 * are polling loops. There is no push here, no websocket, no reorg feed — four
 * chain families offer four incompatible subscription mechanisms and three of
 * the public endpoints this tool defaults to do not expose any of them.
 *
 * Saying so matters, because the gap between "subscribed" and "polled every
 * twelve seconds" is exactly where an application draws a wrong conclusion.
 * A poll can miss a value that changed and changed back. It can miss a
 * transaction that was mined and reorged out between two ticks. It reports
 * *the state at the times it asked*, which is a weaker claim than "everything
 * that happened", and every handler below is documented in those terms.
 *
 * What the loops do guarantee:
 *
 * - **No overlap.** A tick that is still running when the next is due delays
 *   the next one rather than racing it. A slow endpoint produces a slow watch,
 *   never a pile-up.
 * - **Backoff on failure.** Consecutive errors widen the interval rather than
 *   hammering an endpoint that is already struggling, and reset on the first
 *   success.
 * - **Errors are delivered, not swallowed.** A watch that silently stops is
 *   worse than one that never started. `onError` sees every failure; without
 *   one, the failure goes to `console.error` rather than nowhere.
 * - **Change detection over re-delivery.** Handlers fire when the value
 *   changes, not on every tick. The first tick is a change by definition —
 *   there is nothing to compare it to — and is delivered so a UI has something
 *   to render.
 */

import { operations } from 'singularity-agent';
import type {
  BalanceResult,
  ChainLiveness,
  NormalizedBlock,
  NormalizedTx,
} from './types.js';
import { withRetry, type RetryPolicy } from './cache.js';
import { SdkError } from './errors.js';

/** A running watch. */
export interface Subscription {
  /** Stop polling. Idempotent; safe to call from inside a handler. */
  stop(): void;
  /** False once {@link Subscription.stop} has been called. */
  readonly active: boolean;
  /**
   * Resolves when the watch stops — by `stop()`, by its abort signal, or
   * because `until` was satisfied. Rejects only if `onError` itself threw.
   */
  readonly done: Promise<void>;
}

export interface WatchOptions {
  /** Milliseconds between ticks. Floored at 1000; see the note in `loop`. */
  intervalMs?: number;
  /** Stop when this aborts. */
  signal?: AbortSignal;
  /** Called on every failed tick. Without one, failures go to `console.error`. */
  onError?: (err: unknown) => void;
  /**
   * Stop after this many consecutive failures. Default 0 — never stop, keep
   * backing off. Set it when a watch feeding a UI should surface a dead
   * endpoint rather than retrying behind a spinner forever.
   */
  stopAfterErrors?: number;
}

/**
 * A change, and enough context to act on it.
 *
 * `previous` is absent on the first delivery. That is the signal that this is
 * an initial reading rather than a transition — a balance alert that does not
 * check it will fire on startup for every address it watches.
 */
export interface Change<T> {
  value: T;
  previous?: T;
  /** Ticks since the watch started, first delivery included. */
  tick: number;
  at: Date;
}

export type Handler<T> = (change: Change<T>) => void | Promise<void>;

export interface WatchApi {
  /**
   * Native and token balances for an address.
   *
   * Fires when the rendered balance changes. Compares the *native amount and
   * the token list*, not the whole result object, so a fresh block number or a
   * re-worded completeness note does not read as a balance change.
   *
   * The completeness envelope rides through untouched. A `curated` token scan
   * that gains an entry means a curated token moved — it does not mean the
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
   * Fires on every new height. Heights can arrive out of order across a reorg;
   * the handler sees what the endpoint reported, including a height lower than
   * the one before it, because hiding that would hide the reorg.
   */
  tip(chain: string | undefined, handler: Handler<NormalizedBlock>, watch?: WatchOptions): Subscription;

  /**
   * One transaction, until it reaches the confirmation depth you asked for.
   *
   * Fires on every change to its finality, then stops on its own once
   * `confirmations` is met — this is the one watch with a natural end. A
   * transaction that never appears keeps polling; it is not an error, because
   * "not yet mined" and "never will be" are indistinguishable from here.
   */
  transaction(
    options: { hash: string; chain?: string; confirmations?: number },
    handler: Handler<NormalizedTx>,
    watch?: WatchOptions,
  ): Subscription;

  /**
   * Chain health, for a monitor.
   *
   * Fires when any chain's status changes. Not cached anywhere in this SDK —
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

  const read = <T>(work: () => Promise<T>) => withRetry(deps.retry, work);

  return {
    balance(options, handler, watch = {}) {
      const chain = chainOf(options.chain);
      return loop(
        () => read(() => operations.getBalance({ ...options, chain })),
        // The identity of a balance, for change detection: the native amount
        // and every token amount. Deliberately not the whole object — that
        // carries an explorer URL and a note, and comparing those would fire
        // this handler on cosmetic churn.
        (b) => `${b.native.amount.formatted}|${b.tokens.map((t) => `${t.token?.symbol ?? '?'}:${t.amount.formatted}`).sort().join(',')}`,
        handler,
        watch,
      );
    },

    tip(chain, handler, watch = {}) {
      const id = chainOf(chain);
      return loop(
        () => read(() => operations.getBlock({ chain: id })),
        (block) => String(block.number),
        handler,
        watch,
      );
    },

    transaction(options, handler, watch = {}) {
      const target = options.confirmations ?? 1;
      let settled = false;

      return loop(
        async () => {
          const result = await read(() => operations.getTransaction(options));
          const tx = result.found[0];
          if (!tx) return undefined; // Not mined yet. Not a change, not an error.
          if ((tx.finality?.confirmations ?? 0) >= target) settled = true;
          return tx;
        },
        (tx) => `${tx.status}|${tx.finality?.confirmations ?? 0}|${tx.finality?.kind ?? ''}`,
        handler,
        { ...watch, until: () => settled },
      );
    },

    liveness(chains, handler, watch = {}) {
      return loop(
        () => operations.checkLiveness(chains),
        (all) => all.map((c) => `${c.chain}:${c.status}`).join(','),
        handler,
        watch,
      );
    },
  };
}

interface LoopOptions extends WatchOptions {
  /** Checked after each delivery; true stops the watch cleanly. */
  until?: () => boolean;
}

/**
 * The one polling loop every watch above is built from.
 *
 * `identity` is what makes a tick a change. It returns a string rather than
 * taking a deep-equality helper, because deciding *which fields count* is the
 * interesting part and it differs per watch — a block number is the whole
 * answer for a tip and irrelevant for a balance.
 *
 * A tick returning `undefined` means "nothing to report yet" — not an error,
 * not a change. A pending transaction sits there indefinitely without firing a
 * handler or logging anything.
 */
function loop<T>(
  tick: () => Promise<T | undefined>,
  identity: (value: T) => string,
  handler: Handler<T>,
  options: LoopOptions,
): Subscription {
  // A floor rather than a default only. Below about a second the poll costs
  // more in rate-limit budget than it buys in freshness on every public
  // endpoint this tool ships with, and the first thing a tight loop does is get
  // the caller's key throttled — which looks like the chain being down.
  const interval = Math.max(1_000, options.intervalMs ?? 12_000);
  const maxBackoff = Math.max(interval, 60_000);

  let active = true;
  let previous: T | undefined;
  let lastIdentity: string | undefined;
  let count = 0;
  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let resolveDone: () => void;
  let rejectDone: (err: unknown) => void;

  const done = new Promise<void>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });

  const stop = (): void => {
    if (!active) return;
    active = false;
    if (timer) clearTimeout(timer);
    options.signal?.removeEventListener('abort', stop);
    resolveDone();
  };

  options.signal?.addEventListener('abort', stop, { once: true });
  if (options.signal?.aborted) {
    stop();
    return { stop, get active() { return active; }, done };
  }

  const schedule = (ms: number): void => {
    if (!active) return;
    timer = setTimeout(run, ms);
    // Do not hold the process open for a watch nobody is waiting on. A CLI
    // that starts a watch and finishes its work should exit; a server holding
    // its own handle stays up regardless.
    timer.unref?.();
  };

  const run = async (): Promise<void> => {
    if (!active) return;

    try {
      const value = await tick();
      failures = 0;

      if (value !== undefined) {
        const id = identity(value);
        if (id !== lastIdentity) {
          count += 1;
          const change: Change<T> = {
            value,
            ...(previous !== undefined ? { previous } : {}),
            tick: count,
            at: new Date(),
          };
          lastIdentity = id;
          previous = value;
          await handler(change);
        }
      }

      if (options.until?.()) {
        stop();
        return;
      }

      schedule(interval);
    } catch (err) {
      failures += 1;

      try {
        if (options.onError) options.onError(err);
        else console.error('[singularity-sdk] watch tick failed:', err);
      } catch (handlerErr) {
        // The caller's own error handler threw. There is nowhere left to put
        // this, so the watch stops and `done` carries it out rather than
        // looping on a handler that cannot succeed.
        active = false;
        if (timer) clearTimeout(timer);
        rejectDone(handlerErr);
        return;
      }

      if (options.stopAfterErrors && failures >= options.stopAfterErrors) {
        stop();
        return;
      }

      schedule(Math.min(interval * 2 ** Math.min(failures, 6), maxBackoff));
    }
  };

  schedule(0);

  return {
    stop,
    get active() {
      return active;
    },
    done,
  };
}
