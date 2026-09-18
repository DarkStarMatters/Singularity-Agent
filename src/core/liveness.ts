/**
 * Whether a chain is serving current state, which is not what reachability asks.
 *
 * `doctor` used to call an endpoint healthy when a request to it did not throw.
 * Polygon zkEVM answers, reports chain id 1101, and served a head block 76 days
 * old — so it would have passed, and every read against it would have been
 * historical state wearing a current-state label. That is the bug class this
 * repo exists to catch, sitting inside the command meant to catch it.
 *
 * Three things are asked here that "did it answer" does not:
 *
 * 1. **How old is the head?** A chain that stopped producing blocks still serves
 *    the last one it made, forever, with no error anywhere.
 * 2. **Do the endpoints agree?** Failover takes the first endpoint that answers.
 *    If one of three is hours behind, reads go stale whenever the order happens
 *    to put it first — intermittently, which is harder to notice than always.
 * 3. **How many actually answer?** Two endpoints are the stated failover
 *    guarantee. One that answers and one that is a typo look identical until the
 *    first one rate-limits.
 *
 * Every endpoint is probed on its own rather than through failover, because
 * failover exists to hide exactly the difference being measured.
 */

import type { ChainFamily, ChainSpec } from './types.js';

/** The head of a chain: how high, and — where the chain says — how long ago. */
export interface ChainTip {
  height: number;
  /** ISO 8601. Absent where the endpoint will not say, which is not "now". */
  timestamp?: string;
}

export interface EndpointProbe {
  /** Host only. A configured URL frequently carries an API key. */
  host: string;
  ok: boolean;
  ms: number;
  height?: number;
  timestamp?: string;
  /** Seconds between this endpoint's head and now. Absent when undatable. */
  ageSeconds?: number;
  error?: string;
}

export type LivenessStatus =
  /** Nothing answered. */
  | 'down'
  /** Every endpoint's head is old enough that this is not current state. */
  | 'stale'
  /** Heads far enough apart that which endpoint answers changes the answer. */
  | 'lagging'
  /** Answering, but nothing will say when the head was produced. */
  | 'undatable'
  /** The head is dated in the future, so its age proves nothing. */
  | 'skewed'
  /** Fresh, but only one endpoint answered, so there is no failover. */
  | 'single'
  | 'live';

export interface ChainLiveness {
  chain: string;
  name: string;
  family: ChainFamily;
  status: LivenessStatus;
  /** Endpoints that answered, out of those configured. */
  answering: number;
  configured: number;
  /** Highest head seen from any endpoint. */
  height?: number;
  /** Age of the freshest head — the best any endpoint offered. */
  ageSeconds?: number;
  /** Spread between the freshest and stalest answering endpoint, in seconds. */
  spreadSeconds?: number;
  endpoints: EndpointProbe[];
  notes: string[];
}

/**
 * How old a head may be before the chain is not serving current state.
 *
 * These sit far above any chain's block time. The question is not "is this
 * endpoint a block or two behind" — it always is, and chasing that produces a
 * permanently red board nobody reads. The question is whether the state served
 * is *categorically* not current, which is what a 76-day-old head is. A
 * threshold generous enough never to fire on a healthy chain is the only kind
 * whose firing means anything.
 *
 * Per-chain block times are deliberately not used. This file would then carry 32
 * numbers read off documentation rather than off a chain, and a wrong one fails
 * in the direction of calling a live chain dead.
 */
const STALE_AFTER_SECONDS: Record<ChainFamily, number> = {
  /** Ethereum is 12s and the L2s are faster; 15 minutes is ~75 missed blocks. */
  evm: 900,
  /** Solana is sub-second. Five minutes is an outage, not a hiccup. */
  svm: 300,
  /** Tendermint targets ~6s and halts outright rather than slowing down. */
  cosmos: 900,
  /**
   * Bitcoin targets 10 minutes and the interval is exponential — an hour
   * between blocks is unremarkable luck. Three hours is not.
   */
  utxo: 10_800,
};

/**
 * How far apart two endpoints' heads may be before failover is load-bearing.
 *
 * Two minutes is above normal propagation on every family here, and below the
 * point where a caller would have noticed on their own.
 */
const LAG_SPREAD_SECONDS = 120;

/**
 * How far into the future a head may be dated before the date is unusable.
 *
 * Some negative age is ordinary: the local clock is not the chain's, and a few
 * seconds either way says nothing. Beyond that it is a real property of some
 * chains rather than an error — Bitcoin accepts a block timestamp up to two
 * hours ahead of network-adjusted time, and testnet routinely uses the room.
 *
 * It matters because an unclamped negative age is *smaller* than every
 * threshold in this file, so a head dated in the future reads as fresher than a
 * fresh one. A chain that cannot be dated must never come out looking live,
 * which is the same rule `undatable` exists for.
 */
const FUTURE_TOLERANCE_SECONDS = 120;

/** Host without path or query, since a configured URL may embed a key. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function ageOf(timestamp: string | undefined, now: number): number | undefined {
  if (!timestamp) return undefined;
  const at = Date.parse(timestamp);
  if (Number.isNaN(at)) return undefined;
  return Math.round((now - at) / 1000);
}

/**
 * Probe one endpoint, in isolation.
 *
 * The chain is rewritten to hold this endpoint alone so the adapter's own
 * failover cannot quietly answer from a different one — which would report a
 * dead endpoint as healthy, and is the whole thing being measured.
 */
export async function probeEndpoint(
  chain: ChainSpec,
  endpoint: string,
  tip: (chain: ChainSpec) => Promise<ChainTip>,
  now: number = Date.now(),
): Promise<EndpointProbe> {
  const isolated: ChainSpec = { ...chain, rpc: [endpoint] };
  const started = Date.now();

  try {
    const head = await tip(isolated);
    return {
      host: hostOf(endpoint),
      ok: true,
      ms: Date.now() - started,
      height: head.height,
      timestamp: head.timestamp,
      ageSeconds: ageOf(head.timestamp, now),
    };
  } catch (err) {
    return {
      host: hostOf(endpoint),
      ok: false,
      ms: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Run one task per endpoint, serialized by host.
 *
 * A full sweep is around eighty endpoints, and firing them at once would make
 * the probe the outage: `rest.cosmos.directory` alone serves nine of the Cosmos
 * chains here, so the naive parallel version asks one host nine simultaneous
 * questions and reports the chains it rate-limits as down.
 *
 * That is not a hypothetical failure mode for this repo — Sei was nearly
 * excluded from a release because a probe bug reported four healthy endpoints
 * as silent. A measurement that disagrees with reality is the same class of
 * defect as a wrong balance, and it does not stop being one because it is the
 * measurement doing the lying. Distinct hosts still run in parallel, so the
 * sweep stays fast without any host seeing more than one request at a time.
 */
export async function runSerializedByHost<T, R>(
  items: T[],
  hostOfItem: (item: T) => string,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  const byHost = new Map<string, number[]>();

  items.forEach((item, index) => {
    const host = hostOfItem(item);
    const bucket = byHost.get(host);
    if (bucket) bucket.push(index);
    else byHost.set(host, [index]);
  });

  await Promise.all(
    [...byHost.values()].map(async (indexes) => {
      for (const index of indexes) {
        results[index] = await run(items[index]!);
      }
    }),
  );

  return results;
}

/**
 * Turn a set of endpoint probes into one statement about the chain.
 *
 * Split out from the probing so it is testable without a network: every status
 * below is a claim someone could act on, and the Polygon zkEVM case belongs in a
 * unit test rather than in a story about how it was once noticed.
 */
export function classify(chain: ChainSpec, endpoints: EndpointProbe[]): ChainLiveness {
  const answering = endpoints.filter((e) => e.ok);

  const base = {
    chain: chain.id,
    name: chain.name,
    family: chain.family,
    answering: answering.length,
    configured: endpoints.length,
    endpoints,
  };

  if (!answering.length) {
    return { ...base, status: 'down' as const, notes: ['No configured endpoint answered.'] };
  }

  const heights = answering.map((e) => e.height).filter((h): h is number => h !== undefined);
  const height = heights.length ? Math.max(...heights) : undefined;
  const ages = answering.map((e) => e.ageSeconds).filter((a): a is number => a !== undefined);
  const notes: string[] = [];

  if (answering.length < 2) {
    notes.push(
      base.configured < 2
        ? 'Only one endpoint is configured, so there is no failover.'
        : `${base.configured - answering.length} of ${base.configured} endpoints did not answer, leaving no failover.`,
    );
  }

  if (!ages.length) {
    notes.push('No endpoint dated its head block, so freshness could not be checked.');
    return { ...base, status: 'undatable' as const, height, notes };
  }

  const rawAge = Math.min(...ages);

  if (rawAge < -FUTURE_TOLERANCE_SECONDS) {
    notes.unshift(
      `Head block is dated ${describeAge(-rawAge)} in the future, so its age cannot be used. ` +
        'Nothing here says the chain is stalled — only that this endpoint cannot prove it is not.',
    );
    return { ...base, status: 'skewed' as const, height, notes };
  }

  // Everything from here compares against thresholds, and a negative age beats
  // all of them. Ordinary clock skew is rounded away rather than being allowed
  // to make a chain look fresher than one whose head is genuinely current.
  const ageSeconds = Math.max(0, rawAge);
  const spreadSeconds = Math.max(0, Math.max(...ages)) - ageSeconds;
  const threshold = STALE_AFTER_SECONDS[chain.family];

  if (ageSeconds > threshold) {
    notes.unshift(
      `Head block is ${describeAge(ageSeconds)} old, past the ${describeAge(threshold)} this family allows. ` +
        'Every read here is historical state wearing a current-state label.',
    );
    return { ...base, status: 'stale' as const, height, ageSeconds, spreadSeconds, notes };
  }

  if (spreadSeconds > LAG_SPREAD_SECONDS && answering.length > 1) {
    const stalest = answering.reduce((a, b) => ((b.ageSeconds ?? 0) > (a.ageSeconds ?? 0) ? b : a));
    notes.unshift(
      `Endpoints disagree by ${describeAge(spreadSeconds)}; ${stalest.host} is the one behind. ` +
        'Failover takes whichever answers first, so reads go stale intermittently.',
    );
    return { ...base, status: 'lagging' as const, height, ageSeconds, spreadSeconds, notes };
  }

  return {
    ...base,
    status: answering.length < 2 ? ('single' as const) : ('live' as const),
    height,
    ageSeconds,
    spreadSeconds,
    notes,
  };
}

/** Whole seconds are unreadable past a minute and misleading past a day. */
export function describeAge(seconds: number): string {
  if (seconds < 90) return `${seconds}s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m`;
  if (seconds < 172_800) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86_400)}d`;
}

/** A status worth acting on, for an exit code or a summary line. */
export function isDegraded(status: LivenessStatus): boolean {
  return status !== 'live';
}

export const THRESHOLDS = { STALE_AFTER_SECONDS, LAG_SPREAD_SECONDS } as const;
