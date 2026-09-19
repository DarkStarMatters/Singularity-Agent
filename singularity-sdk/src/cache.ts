/**
 * A read cache, and the rule about what may go in it.
 *
 * An application makes the same read far more often than a CLI does — a
 * dashboard polling four chains, a bot answering the same question for forty
 * people, a page that re-renders. Caching that is the obvious win and also the
 * obvious way to start serving confidently wrong answers, which is the exact
 * failure class this project keeps writing tests about.
 *
 * So the rule is not "cache reads". It is: **a cached answer may only be wrong
 * in the direction that is already safe.**
 *
 * - A **historical** read — anything with `atBlock` pinned — is immutable once
 *   the block is final. It can be cached for a long time, and is.
 * - A **current-state** read is stale the instant it returns. It gets a short
 *   TTL, the caller sets it, and the default is off.
 * - A **liveness or health** probe is never cached at any TTL. Its entire job
 *   is to tell you whether something is responding *now*; a cached "yes" is
 *   indistinguishable from the outage it exists to catch. There is no option
 *   to turn this on, because the option would be a bug with a config flag in
 *   front of it.
 *
 * Completeness rides along untouched. A cached `truncated` is still
 * `truncated`; nothing here rewrites an envelope.
 */

/** How long an entry stays usable, by what kind of read produced it. */
export interface CacheTtl {
  /** Reads pinned to a block height. Immutable in practice. Default 5 min. */
  historical: number;
  /** Current-state reads: balances, blocks, fees. Default 0 — off. */
  current: number;
  /** Chain metadata and name resolution. Slow-moving. Default 60s. */
  metadata: number;
}

export const DEFAULT_TTL: CacheTtl = {
  historical: 300_000,
  current: 0,
  metadata: 60_000,
};

export type CacheClass = keyof CacheTtl;

interface Entry {
  value: unknown;
  expires: number;
}

export interface CacheStats {
  hits: number;
  misses: number;
  entries: number;
}

/**
 * A bounded TTL cache.
 *
 * Bounded because the natural key space here is "every address anyone asks
 * about", which is unbounded, and a long-running bot with an unbounded cache is
 * a memory leak with a latency improvement. Eviction is insertion-order oldest
 * first — not LRU, which would need bookkeeping on every read to defend against
 * a workload this cache is not big enough to have.
 */
export class ReadCache {
  private readonly store = new Map<string, Entry>();
  private hits = 0;
  private misses = 0;

  constructor(
    private readonly ttl: CacheTtl = DEFAULT_TTL,
    private readonly maxEntries = 500,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Run `work`, serving a live cached value where one exists.
   *
   * A TTL of 0 short-circuits entirely: nothing is stored, nothing is read, and
   * the call is indistinguishable from not having a cache. That is what makes
   * `current: 0` a real default rather than a small TTL wearing a disguise.
   */
  async through<T>(cls: CacheClass, key: string, work: () => Promise<T>): Promise<T> {
    const ttl = this.ttl[cls];
    if (ttl <= 0) return work();

    const full = `${cls}:${key}`;
    const hit = this.store.get(full);

    if (hit && hit.expires > this.now()) {
      this.hits += 1;
      return hit.value as T;
    }

    this.misses += 1;
    const value = await work();

    // Only successful reads land here — a rejection propagates without being
    // stored, because caching a failure turns one bad minute on an endpoint
    // into a bad minute that outlives it.
    this.store.delete(full);
    this.store.set(full, { value, expires: this.now() + ttl });
    this.evict();
    return value;
  }

  private evict(): void {
    while (this.store.size > this.maxEntries) {
      const oldest = this.store.keys().next();
      if (oldest.done) break;
      this.store.delete(oldest.value);
    }
  }

  clear(): void {
    this.store.clear();
  }

  stats(): CacheStats {
    return { hits: this.hits, misses: this.misses, entries: this.store.size };
  }
}

/** Stable cache key for an operation and its arguments. */
export function cacheKey(op: string, args: unknown): string {
  return `${op}(${stable(args)})`;
}

/**
 * JSON with sorted keys, so `{a,b}` and `{b,a}` are one cache entry rather than
 * two. `undefined` members are dropped, matching the way the operations
 * themselves treat an omitted option.
 */
function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(',')}}`;
}

export interface RetryPolicy {
  /** Total attempts, including the first. 1 disables retrying. */
  attempts: number;
  /** Delay before the second attempt, in ms. Doubles each time after. */
  baseDelayMs: number;
  /** Ceiling on any single delay. */
  maxDelayMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = {
  attempts: 3,
  baseDelayMs: 250,
  maxDelayMs: 4_000,
};

/**
 * Retry the transient failures and nothing else.
 *
 * Public RPC endpoints rate-limit, time out and occasionally 502; those are
 * worth another attempt. A bad address, an unsupported operation or a failed
 * decode will fail identically forever, and retrying them only makes the user
 * wait longer to read the hint that was correct the first time. The split is by
 * error code where the core supplies one, and by message shape where it does
 * not.
 */
export async function withRetry<T>(
  policy: RetryPolicy,
  work: () => Promise<T>,
  sleep: (ms: number) => Promise<void> = defaultSleep,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= Math.max(1, policy.attempts); attempt += 1) {
    try {
      return await work();
    } catch (err) {
      lastError = err;
      if (attempt >= policy.attempts || !isTransient(err)) throw err;
      const delay = Math.min(policy.baseDelayMs * 2 ** (attempt - 1), policy.maxDelayMs);
      await sleep(delay);
    }
  }

  throw lastError;
}

/** Deterministic codes and message shapes that mean "ask again". */
export function isTransient(err: unknown): boolean {
  const code = (err as { code?: unknown })?.code;

  if (typeof code === 'string') {
    if (code === 'RPC_ERROR' || code === 'TIMEOUT' || code === 'NETWORK_ERROR') return true;
    // Everything else the core names is a statement about the request, and the
    // request will not have changed by the next attempt.
    return false;
  }

  const message = String((err as { message?: unknown })?.message ?? err).toLowerCase();
  return (
    message.includes('timeout') ||
    message.includes('timed out') ||
    message.includes('econnreset') ||
    message.includes('etimedout') ||
    message.includes('econnrefused') ||
    message.includes('socket hang up') ||
    message.includes('fetch failed') ||
    message.includes('rate limit') ||
    message.includes('too many requests') ||
    message.includes('429') ||
    message.includes('502') ||
    message.includes('503') ||
    message.includes('504')
  );
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
