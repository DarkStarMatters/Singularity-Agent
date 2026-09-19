/**
 * Polling, and the discipline that makes it honest.
 *
 * This is the one loop behind every watch in the project — `singularity watch`
 * on the CLI, and `sdk.watch.*` in `singularity-sdk`. It lives here rather than
 * in the SDK because both of them need it and only one of them can own it: the
 * SDK depends on this package, never the other way round, so a loop that lived
 * up there would mean the CLI reimplementing it. Two loops is two sets of
 * backoff semantics, and the one that gets fixed is whichever one somebody
 * happened to be looking at.
 *
 * ── What a poll is, said plainly ────────────────────────────────────────────
 *
 * This is not a subscription. There is no push here, no websocket, no reorg
 * feed — four chain families offer four incompatible subscription mechanisms
 * and most of the public endpoints this tool defaults to expose none of them.
 *
 * Saying so matters, because the gap between "subscribed" and "asked every
 * twelve seconds" is exactly where a caller draws a wrong conclusion. A poll
 * can miss a value that changed and changed back between two ticks. It can miss
 * a transaction that was mined and reorged out inside one interval. It reports
 * *the state at the times it asked*, which is a strictly weaker claim than
 * "everything that happened", and nothing downstream should upgrade it.
 *
 * ── What it does guarantee ──────────────────────────────────────────────────
 *
 * - **No overlap.** The next tick is scheduled when the last one finishes, not
 *   on a fixed cadence. A slow endpoint produces a slow watch, never a pile-up
 *   of in-flight requests racing each other.
 * - **Backoff on failure.** Consecutive errors widen the interval rather than
 *   hammering an endpoint that is already struggling, and reset on the first
 *   success.
 * - **Errors are delivered, never swallowed.** A watch that silently stops is
 *   worse than one that never started, because the caller keeps believing it.
 * - **Change detection, not re-delivery.** The handler fires when the value
 *   changes. The first reading is a change by definition — there is nothing to
 *   compare it against — and arrives with `previous` absent, which is the flag
 *   that stops an alert firing for every address it watches on startup.
 */

/** A running watch. */
export interface Subscription {
  /** Stop polling. Idempotent, and safe to call from inside a handler. */
  stop(): void;
  /** False once {@link Subscription.stop} has been called. */
  readonly active: boolean;
  /**
   * Resolves when the watch stops — by `stop()`, by its abort signal, or
   * because `until` was satisfied. Rejects only if `onError` itself threw,
   * because at that point there is nowhere left to put the failure.
   */
  readonly done: Promise<void>;
}

export interface WatchOptions {
  /** Milliseconds between ticks. Floored at 1000; see {@link pollLoop}. */
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
 * an initial reading rather than a transition, and the thing a handler has to
 * check before it treats a value as news.
 */
export interface Change<T> {
  value: T;
  previous?: T;
  /** Deliveries since the watch started, this one included. */
  tick: number;
  at: Date;
}

export type Handler<T> = (change: Change<T>) => void | Promise<void>;

export interface PollOptions extends WatchOptions {
  /** Checked after each delivery; true stops the watch cleanly. */
  until?: () => boolean;
  /** Prefix for the fallback error log, when no `onError` was given. */
  label?: string;
}

/**
 * Poll `tick`, and deliver the changes.
 *
 * `identity` is what makes a tick a change. It returns a string rather than
 * taking a deep-equality helper, because deciding *which fields count* is the
 * interesting part and it differs per watch — a block number is the whole
 * answer for a chain tip and irrelevant for a balance, where a re-worded
 * completeness note must not read as money moving.
 *
 * A tick returning `undefined` means "nothing to report yet" — not an error and
 * not a change. A transaction that has not been mined sits there indefinitely
 * without firing a handler or logging anything, because "not yet" and "never"
 * are indistinguishable from here and only one of them is worth waking someone
 * up for.
 */
export function pollLoop<T>(
  tick: () => Promise<T | undefined>,
  identity: (value: T) => string,
  handler: Handler<T>,
  options: PollOptions = {},
): Subscription {
  // A floor, not merely a default. Below about a second a poll costs more in
  // rate-limit budget than it buys in freshness on every public endpoint this
  // tool ships with, and the first thing a tight loop does is get the caller
  // throttled — which then looks exactly like the chain being down.
  const interval = Math.max(1_000, options.intervalMs ?? 12_000);
  const maxBackoff = Math.max(interval, 60_000);

  let active = true;
  let previous: T | undefined;
  let lastIdentity: string | undefined;
  let count = 0;
  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let resolveDone!: () => void;
  let rejectDone!: (err: unknown) => void;

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

  const subscription: Subscription = {
    stop,
    get active() {
      return active;
    },
    done,
  };

  options.signal?.addEventListener('abort', stop, { once: true });
  if (options.signal?.aborted) {
    stop();
    return subscription;
  }

  const schedule = (ms: number): void => {
    if (!active) return;
    timer = setTimeout(run, ms);
    // Do not hold the process open on a watch nobody is waiting on. A script
    // that starts one and finishes its work should exit; a long-running process
    // keeps its own handle and stays up regardless.
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
        else console.error(`[${options.label ?? 'watch'}] tick failed:`, err);
      } catch (handlerErr) {
        // The caller's own error handler threw. There is nowhere left to put
        // this, so the watch stops and `done` carries it out, rather than
        // looping forever on a handler that cannot succeed.
        active = false;
        if (timer) clearTimeout(timer);
        options.signal?.removeEventListener('abort', stop);
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
  return subscription;
}
