/**
 * The built-in endpoints, as they answered on the day a release was cut.
 *
 * "Every mainnet has failover" was held by a test that counted entries in a
 * config file. Counting cannot see whether any of them answer, and on the day
 * `doctor` learned to ask, Ethereum was answering from one endpoint of three.
 * Pointing that test at the network instead would make CI flaky by
 * construction, and a test that is sometimes red trains everyone to ignore it.
 *
 * So the network is asked once, by a person, and the answer is committed.
 * `npm run snapshot:endpoints` writes `test/endpoint-snapshot.json`, and the
 * test compares the configuration against that file rather than against the
 * wire. A dead endpoint becomes a diff somebody reviews, and a configuration
 * change without a fresh snapshot fails, because the snapshot no longer
 * describes what is configured.
 *
 * Only the built-in list is probed, never the caller's overrides. Overrides
 * can carry API keys, and this file is committed.
 */

import { THRESHOLDS, type EndpointProbe } from './liveness.js';
import type { ChainFamily, ChainSpec } from './types.js';

/**
 * Deliberately no height and no age. Both change on every run, and a snapshot
 * that rewrites every line each time hides the one line that matters in the
 * noise. These fields change only when an endpoint's standing does.
 */
export interface SnapshotEndpoint {
  /** It answered at all. */
  ok: boolean;
  /** It answered with a dated head young enough to be current state. */
  current: boolean;
  /** First line only, and only when it did not answer. The rest is a request dump. */
  error?: string;
}

export interface EndpointSnapshot {
  /** The release this snapshot was taken for. */
  version: string;
  takenAt: string;
  chains: Record<string, { family: ChainFamily; testnet: boolean; endpoints: Record<string, SnapshotEndpoint> }>;
}

/** Chains a snapshot covers: every built-in chain that has public endpoints. */
export function snapshotChains(builtin: ChainSpec[]): ChainSpec[] {
  return builtin.filter((chain) => !chain.requiresOwnNode);
}

export function buildSnapshot(
  version: string,
  chains: ChainSpec[],
  probesFor: (chain: ChainSpec) => EndpointProbe[],
  takenAt: Date = new Date(),
): EndpointSnapshot {
  const snapshot: EndpointSnapshot = { version, takenAt: takenAt.toISOString(), chains: {} };

  for (const chain of chains) {
    const probes = probesFor(chain);
    const endpoints: Record<string, SnapshotEndpoint> = {};

    chain.rpc.forEach((url, index) => {
      const probe = probes[index]!;
      endpoints[url] = {
        ok: probe.ok,
        current: servedCurrentState(probe, chain.family),
        ...(probe.error ? { error: probe.error.split('\n')[0]!.slice(0, 160) } : {}),
      };
    });

    snapshot.chains[chain.id] = { family: chain.family, testnet: chain.testnet === true, endpoints };
  }

  return snapshot;
}

/**
 * Whether an endpoint counts toward failover: it answered, and the head it
 * served was dated and current. An endpoint that answers with a head from last
 * month is not somewhere to fail over to, and one that will not date its head
 * cannot show that it is, which is the rule `undatable` follows.
 */
export function servedCurrentState(endpoint: Pick<EndpointProbe, 'ok' | 'ageSeconds'>, family: ChainFamily): boolean {
  if (!endpoint.ok || endpoint.ageSeconds === undefined) return false;
  return endpoint.ageSeconds <= THRESHOLDS.STALE_AFTER_SECONDS[family];
}
