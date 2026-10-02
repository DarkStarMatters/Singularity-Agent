/**
 * Liveness over time: the questions `chain_liveness` cannot answer by itself.
 *
 * A liveness check is a point measurement. "Is this chain live" is answerable
 * from one sweep. "When did it stop", "how often does this endpoint lag" and
 * "has the endpoint list decayed since the release that added it" are not,
 * because each one is a question about change. A tool that holds nothing
 * between calls cannot answer any of them.
 *
 * So this file is the first place Singularity keeps state it was not handed,
 * and it does so the way `IntentStore` does. `LivenessHistory` is a port. The
 * application owns the database, the retention policy and the backup story.
 * This project ships an in-memory store that says what it is in its name, and
 * a file store that is written only when somebody asks (`doctor --record`). A
 * read-only client that quietly grew a data directory would be the same kind
 * of mistake as a guarantee that lives in prose.
 *
 * The analysis is a pure function of the samples, and it says how much it
 * knows. A history is a handful of readings with unknown gaps between them,
 * not a continuous record. Every summary carries how many samples there were,
 * the window they cover and the largest gap, and an endpoint seen too few times
 * is `unproven` rather than healthy.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { completeness, type Completeness } from './envelope.js';
import { describeAge, hostOf, THRESHOLDS, type ChainLiveness, type EndpointProbe, type LivenessStatus } from './liveness.js';
import type { ChainSpec } from './types.js';

/** One chain, as one sweep found it. */
export interface LivenessSample {
  /** ISO 8601, when the sweep ran. */
  at: string;
  chain: string;
  status: LivenessStatus;
  answering: number;
  configured: number;
  endpoints: SampledEndpoint[];
}

/** An endpoint probe without the parts that do not belong on disk. */
export type SampledEndpoint = Pick<EndpointProbe, 'host' | 'ok' | 'ms' | 'height' | 'ageSeconds' | 'error'>;

export interface HistoryQuery {
  /** Chain ids. All chains when omitted. */
  chains?: string[];
  /** ISO 8601. Samples before this are left out. */
  since?: string;
}

export interface HistoryRead {
  /** Oldest first. */
  samples: LivenessSample[];
  /**
   * Records the store could not read. A file store counts an interrupted
   * append here rather than failing every later read on it, and the summary
   * reports the count, because a skipped record is a gap.
   */
  skipped: number;
}

/**
 * Where liveness samples are kept.
 *
 * The same shape as `IntentStore`, for the same reason: an application that
 * runs `doctor` on a schedule already has somewhere to put things, and should
 * not have to accept this library's idea of where.
 */
export interface LivenessHistory {
  record(samples: LivenessSample[]): Promise<void>;
  read(query?: HistoryQuery): Promise<HistoryRead>;
}

/** An error message is the only unbounded field, and it is not worth a kilobyte a line. */
const MAX_ERROR_LENGTH = 200;

/** A liveness report, as it should be stored. */
export function sampleOf(report: ChainLiveness, at: Date = new Date()): LivenessSample {
  return {
    at: at.toISOString(),
    chain: report.chain,
    status: report.status,
    answering: report.answering,
    configured: report.configured,
    endpoints: report.endpoints.map((endpoint) => ({
      host: endpoint.host,
      ok: endpoint.ok,
      ms: endpoint.ms,
      ...(endpoint.height !== undefined ? { height: endpoint.height } : {}),
      ...(endpoint.ageSeconds !== undefined ? { ageSeconds: endpoint.ageSeconds } : {}),
      ...(endpoint.error !== undefined ? { error: endpoint.error.slice(0, MAX_ERROR_LENGTH) } : {}),
    })),
  };
}

function matches(sample: LivenessSample, query: HistoryQuery | undefined): boolean {
  if (query?.chains?.length && !query.chains.includes(sample.chain)) return false;
  if (query?.since && sample.at < query.since) return false;
  return true;
}

function oldestFirst(a: LivenessSample, b: LivenessSample): number {
  return a.at.localeCompare(b.at);
}

/**
 * An in-memory history, for tests and for a process that summarises its own
 * sweeps. It loses everything on restart, which is fine for a history nobody
 * asked to keep and wrong for one anybody did.
 */
export class InMemoryLivenessHistory implements LivenessHistory {
  private readonly samples: LivenessSample[] = [];

  async record(samples: LivenessSample[]): Promise<void> {
    this.samples.push(...samples);
  }

  async read(query?: HistoryQuery): Promise<HistoryRead> {
    return { samples: this.samples.filter((s) => matches(s, query)).sort(oldestFirst), skipped: 0 };
  }
}

export function livenessHistoryPath(): string {
  return process.env.SINGULARITY_LIVENESS_HISTORY || join(homedir(), '.singularity', 'liveness.jsonl');
}

/**
 * A history kept as JSON lines, one sample per line, appended.
 *
 * Appending rather than rewriting is deliberate. The burn ledger and the intent
 * store rewrite their file whole because a record in them changes. A sample
 * never changes, and an append cannot lose the samples before it.
 *
 * It keeps everything it is given. Retention is the caller's decision: delete
 * the file, or trim it by date. A sweep of every chain is about 30 lines.
 */
export class FileLivenessHistory implements LivenessHistory {
  constructor(private readonly path: string = livenessHistoryPath()) {}

  async record(samples: LivenessSample[]): Promise<void> {
    if (!samples.length) return;
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, samples.map((s) => `${JSON.stringify(s)}\n`).join(''), 'utf8');
  }

  async read(query?: HistoryQuery): Promise<HistoryRead> {
    if (!existsSync(this.path)) return { samples: [], skipped: 0 };

    const samples: LivenessSample[] = [];
    let skipped = 0;

    for (const line of readFileSync(this.path, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const sample = JSON.parse(line) as LivenessSample;
        if (typeof sample?.at !== 'string' || typeof sample.chain !== 'string' || !Array.isArray(sample.endpoints)) {
          skipped += 1;
          continue;
        }
        if (matches(sample, query)) samples.push(sample);
      } catch {
        skipped += 1;
      }
    }

    return { samples: samples.sort(oldestFirst), skipped };
  }
}

/**
 * - `unproven`: seen too few times to say anything.
 * - `dead`: has not answered for long enough, and often enough, to remove.
 * - `silent`: did not answer last time, but not yet for long enough to be dead.
 * - `load-bearing`: was the only endpoint answering at least once, so failover
 *   rested on it.
 * - `lagging`: answers, but its head is usually behind the freshest endpoint.
 * - `flaky`: answers less often than an endpoint in a failover list should.
 * - `healthy`: none of the above.
 */
export type EndpointVerdict = 'unproven' | 'dead' | 'silent' | 'load-bearing' | 'lagging' | 'flaky' | 'healthy';

export interface EndpointHistory {
  host: string;
  verdict: EndpointVerdict;
  /** Samples this endpoint appears in. */
  observations: number;
  answered: number;
  /** Median latency of the answers, in milliseconds. */
  medianMs?: number;
  /**
   * Median seconds this endpoint's head was behind the freshest dated head in
   * the same sweep. Absent when it was never dated alongside another endpoint.
   */
  medianBehindSeconds?: number;
  lastAnswered?: string;
  /** When the current run of failures began, if the latest observation failed. */
  silentSince?: string;
  /** Sweeps in which this was the only endpoint that answered. */
  soleAnswerer: number;
  /**
   * Whether the current configuration still lists this host. Absent when no
   * configuration was given to compare against.
   */
  configured?: boolean;
  /** The most recent error, when the latest observation failed. */
  lastError?: string;
}

export interface ChainHistory {
  chain: string;
  samples: number;
  from: string;
  to: string;
  /** The largest interval between two consecutive samples, in seconds. Nothing is known inside it. */
  largestGapSeconds: number;
  /** The status the latest sample recorded. */
  latest: LivenessStatus;
  /** The latest sample in which the chain was `live`. Absent when it never was in this window. */
  lastLive?: string;
  /**
   * When the current degraded run began, if the latest sample is not `live`.
   * `degradedBeforeWindow` says whether the run started before the first sample,
   * in which case this is only the earliest it is known to have been degraded.
   */
  degradedSince?: string;
  degradedBeforeWindow?: boolean;
  /** Sweeps with at least two endpoints answering, out of `samples`. */
  failoverHeld: number;
  endpoints: EndpointHistory[];
  /** What a caller should know before acting on this, worst first. */
  findings: string[];
}

export interface LivenessHistoryReport {
  chains: ChainHistory[];
  completeness: Completeness;
}

/** Fewer observations than this and an endpoint is `unproven`. */
const MIN_OBSERVATIONS = 3;

/**
 * An endpoint is dead once it has failed this many sweeps in a row, spanning
 * at least `DEAD_AFTER_SECONDS`. Both, because three failures a minute apart is
 * an outage and one failure a week ago is a single bad request.
 */
const DEAD_AFTER_FAILURES = 3;
const DEAD_AFTER_SECONDS = 86_400;

/** Below this share of answers, an endpoint in a failover list is `flaky`. */
const FLAKY_BELOW = 0.9;

function median(values: number[]): number | undefined {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

function seconds(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / 1000);
}

function endpointHistory(host: string, samples: LivenessSample[], configuredHosts?: Set<string>): EndpointHistory {
  const seen: Array<{ at: string; probe: SampledEndpoint; sample: LivenessSample }> = [];
  for (const sample of samples) {
    const probe = sample.endpoints.find((e) => e.host === host);
    if (probe) seen.push({ at: sample.at, probe, sample });
  }

  const answers = seen.filter((s) => s.probe.ok);
  const behind: number[] = [];
  let soleAnswerer = 0;

  for (const { probe, sample } of answers) {
    const answering = sample.endpoints.filter((e) => e.ok);
    if (answering.length === 1) soleAnswerer += 1;

    const dated = answering.map((e) => e.ageSeconds).filter((a): a is number => a !== undefined);
    if (probe.ageSeconds !== undefined && dated.length > 1) {
      behind.push(Math.max(0, probe.ageSeconds - Math.max(0, Math.min(...dated))));
    }
  }

  const lastAnsweredIndex = seen.map((s) => s.probe.ok).lastIndexOf(true);
  const failingRun = seen.slice(lastAnsweredIndex + 1);
  const latest = seen[seen.length - 1];

  const history: EndpointHistory = {
    host,
    verdict: 'healthy',
    observations: seen.length,
    answered: answers.length,
    soleAnswerer,
    ...(answers.length ? { medianMs: median(answers.map((a) => a.probe.ms)) } : {}),
    ...(behind.length ? { medianBehindSeconds: median(behind) } : {}),
    ...(lastAnsweredIndex >= 0 ? { lastAnswered: seen[lastAnsweredIndex]!.at } : {}),
    ...(failingRun.length ? { silentSince: failingRun[0]!.at } : {}),
    ...(configuredHosts ? { configured: configuredHosts.has(host) } : {}),
    ...(latest && !latest.probe.ok && latest.probe.error ? { lastError: latest.probe.error } : {}),
  };

  history.verdict = verdictOf(history, failingRun.length ? seconds(failingRun[0]!.at, latest!.at) : 0, failingRun.length);
  return history;
}

function verdictOf(history: EndpointHistory, failingForSeconds: number, failingSweeps: number): EndpointVerdict {
  if (failingSweeps >= DEAD_AFTER_FAILURES && failingForSeconds >= DEAD_AFTER_SECONDS) return 'dead';
  if (history.observations < MIN_OBSERVATIONS) return 'unproven';
  if (failingSweeps > 0) return 'silent';
  if (history.soleAnswerer > 0) return 'load-bearing';
  if ((history.medianBehindSeconds ?? 0) > THRESHOLDS.LAG_SPREAD_SECONDS) return 'lagging';
  if (history.answered / history.observations < FLAKY_BELOW) return 'flaky';
  return 'healthy';
}

function chainHistory(chain: string, samples: LivenessSample[], spec?: ChainSpec): ChainHistory {
  const configuredHosts = spec ? new Set(spec.rpc.map(hostOf)) : undefined;

  const hosts: string[] = [];
  for (const sample of samples) {
    for (const endpoint of sample.endpoints) if (!hosts.includes(endpoint.host)) hosts.push(endpoint.host);
  }

  const endpoints = hosts.map((host) => endpointHistory(host, samples, configuredHosts));

  let largestGapSeconds = 0;
  for (let i = 1; i < samples.length; i += 1) {
    largestGapSeconds = Math.max(largestGapSeconds, seconds(samples[i - 1]!.at, samples[i]!.at));
  }

  const first = samples[0]!;
  const last = samples[samples.length - 1]!;
  const lastLiveIndex = samples.map((s) => s.status).lastIndexOf('live');
  const degraded = last.status !== 'live';

  const report: ChainHistory = {
    chain,
    samples: samples.length,
    from: first.at,
    to: last.at,
    largestGapSeconds,
    latest: last.status,
    ...(lastLiveIndex >= 0 ? { lastLive: samples[lastLiveIndex]!.at } : {}),
    ...(degraded
      ? { degradedSince: samples[lastLiveIndex + 1]!.at, degradedBeforeWindow: lastLiveIndex < 0 }
      : {}),
    failoverHeld: samples.filter((s) => s.answering >= 2).length,
    endpoints,
    findings: [],
  };

  report.findings = findingsFor(report, configuredHosts);
  return report;
}

function findingsFor(report: ChainHistory, configuredHosts: Set<string> | undefined): string[] {
  const findings: string[] = [];

  if (report.degradedSince) {
    findings.push(
      report.degradedBeforeWindow
        ? `${report.latest} now, and not live in any of the ${report.samples} samples, which go back to ${report.from}. When that began is before this history.`
        : `${report.latest} now, and not live since ${report.degradedSince}, after being live at ${report.lastLive}. It changed somewhere in that interval, not necessarily at its end.`,
    );
  }

  if (configuredHosts) {
    const dead = report.endpoints.filter((e) => e.verdict === 'dead' && e.configured);
    const working = [...configuredHosts].filter((host) => {
      const seen = report.endpoints.find((e) => e.host === host);
      // Answering as of the latest sample it appeared in: neither dead, silent, nor never seen to answer.
      return seen && seen.answered > 0 && seen.verdict !== 'dead' && seen.verdict !== 'silent';
    });

    if (dead.length) {
      findings.push(
        `${dead.map((e) => e.host).join(', ')} ${dead.length === 1 ? 'has' : 'have'} not answered since ` +
          `${dead.map((e) => e.lastAnswered ?? 'before this history').join(', ')}, and ${dead.length === 1 ? 'is' : 'are'} still configured.`,
      );
    }
    if (configuredHosts.size >= 2 && working.length < 2) {
      findings.push(
        `Of ${configuredHosts.size} configured endpoints, ${working.length} ${working.length === 1 ? 'is' : 'are'} answering by this history. ` +
          'The config asserts failover the chain no longer has.',
      );
    }

    const unrecorded = [...configuredHosts].filter((host) => !report.endpoints.some((e) => e.host === host));
    if (unrecorded.length) {
      findings.push(`${unrecorded.join(', ')} ${unrecorded.length === 1 ? 'is' : 'are'} configured but never appears in this history.`);
    }
  }

  const bearing = report.endpoints.filter((e) => e.soleAnswerer > 0);
  if (bearing.length) {
    findings.push(
      bearing
        .map((e) => `${e.host} was the only endpoint answering in ${e.soleAnswerer} of ${report.samples} samples`)
        .join('; ') + '. Without it the chain would have been down.',
    );
  }

  for (const endpoint of report.endpoints.filter((e) => e.verdict === 'lagging')) {
    findings.push(
      `${endpoint.host} is usually ${describeAge(endpoint.medianBehindSeconds!)} behind the freshest endpoint, so reads go stale whenever failover picks it first.`,
    );
  }

  if (report.samples < MIN_OBSERVATIONS) {
    findings.push(`Only ${report.samples} sample${report.samples === 1 ? '' : 's'}. That is a point measurement, not a history.`);
  }

  return findings;
}

/**
 * What a recorded history says about each chain and each of its endpoints.
 *
 * `configured`, when given, is the current chain configuration. With it, the
 * report can say which configured endpoints are dead and whether failover
 * still exists. Without it, it can only describe what was recorded.
 */
export function summarizeHistory(
  read: HistoryRead,
  options: { configured?: ChainSpec[] } = {},
): LivenessHistoryReport {
  const byChain = new Map<string, LivenessSample[]>();
  for (const sample of read.samples) {
    const list = byChain.get(sample.chain);
    if (list) list.push(sample);
    else byChain.set(sample.chain, [sample]);
  }

  const specs = new Map((options.configured ?? []).map((spec) => [spec.id, spec]));
  const chains = [...byChain.entries()].map(([chain, samples]) =>
    chainHistory(chain, [...samples].sort(oldestFirst), options.configured ? specs.get(chain) : undefined),
  );

  if (!chains.length) {
    return {
      chains,
      completeness: completeness.failed(
        read.skipped
          ? `No readable samples; ${read.skipped} records could not be read. There is no history to summarise.`
          : 'Nothing has been recorded. Run `singularity doctor --record` (or record samples through a LivenessHistory) to start a history.',
      ),
    };
  }

  const from = chains.map((c) => c.from).sort()[0]!;
  const to = chains.map((c) => c.to).sort().reverse()[0]!;
  const largest = Math.max(...chains.map((c) => c.largestGapSeconds));

  return {
    chains,
    completeness: completeness.curated(
      `${read.samples.length} samples from ${from} to ${to}, with the largest gap between two samples of one chain ` +
        `${describeAge(largest)}. Nothing is known between samples: an outage shorter than the gap around it is invisible here.` +
        (read.skipped ? ` ${read.skipped} records could not be read and are missing from this history.` : ''),
    ),
  };
}

export const HISTORY_THRESHOLDS = { MIN_OBSERVATIONS, DEAD_AFTER_FAILURES, DEAD_AFTER_SECONDS, FLAKY_BELOW } as const;
