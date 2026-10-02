import { describe, it, expect } from 'vitest';
import { mkdtempSync, appendFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FileLivenessHistory,
  InMemoryLivenessHistory,
  sampleOf,
  summarizeHistory,
  type LivenessSample,
  type SampledEndpoint,
} from '../src/core/liveness-history.js';
import type { ChainLiveness } from '../src/core/liveness.js';
import type { ChainSpec } from '../src/core/types.js';

/**
 * A history is a handful of readings with unknown gaps between them.
 *
 * Every case below is a way to read too much into one: an endpoint seen twice
 * called healthy, one bad request called a dead endpoint, a chain that was
 * never seen live dated as having stopped at the first sample, and a failover
 * list that rotted while the config kept asserting it.
 */

const HOUR = 3_600_000;
const T0 = Date.parse('2026-10-01T00:00:00Z');
const at = (hours: number) => new Date(T0 + hours * HOUR).toISOString();

const up = (host: string, over: Partial<SampledEndpoint> = {}): SampledEndpoint => ({ host, ok: true, ms: 50, ageSeconds: 5, ...over });
const down = (host: string, error = 'fetch failed'): SampledEndpoint => ({ host, ok: false, ms: 5000, error });

function sample(hours: number, endpoints: SampledEndpoint[], over: Partial<LivenessSample> = {}): LivenessSample {
  const answering = endpoints.filter((e) => e.ok).length;
  return {
    at: at(hours),
    chain: 'testchain',
    status: answering >= 2 ? 'live' : answering === 1 ? 'single' : 'down',
    answering,
    configured: endpoints.length,
    endpoints,
    ...over,
  };
}

const spec = (rpc: string[]): ChainSpec => ({
  id: 'testchain',
  name: 'Test Chain',
  family: 'evm',
  chainId: 1,
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpc,
});

const summarize = (samples: LivenessSample[], configured?: ChainSpec[]) =>
  summarizeHistory({ samples, skipped: 0 }, configured ? { configured } : {});

describe('recording a sweep', () => {
  it('keeps what a later question needs and bounds the one unbounded field', () => {
    const report: ChainLiveness = {
      chain: 'testchain',
      name: 'Test Chain',
      family: 'evm',
      status: 'single',
      answering: 1,
      configured: 2,
      height: 100,
      ageSeconds: 4,
      endpoints: [
        { host: 'one.example', ok: true, ms: 40, height: 100, timestamp: '2026-10-01T00:00:00Z', ageSeconds: 4 },
        { host: 'two.example', ok: false, ms: 5000, error: 'x'.repeat(5000) },
      ],
      notes: ['a note that belongs to the moment, not the history'],
    };

    const stored = sampleOf(report, new Date(T0));
    expect(stored.at).toBe(at(0));
    expect(stored.endpoints[0]).toEqual({ host: 'one.example', ok: true, ms: 40, height: 100, ageSeconds: 4 });
    expect(stored.endpoints[1]!.error).toHaveLength(200);
    expect(JSON.stringify(stored)).not.toContain('a note');
  });
});

describe('the in-memory store', () => {
  it('filters by chain and date and returns oldest first', async () => {
    const store = new InMemoryLivenessHistory();
    await store.record([sample(2, [up('a')]), sample(0, [up('a')]), sample(1, [up('a')], { chain: 'other' })]);

    const all = await store.read();
    expect(all.samples.map((s) => s.at)).toEqual([at(0), at(1), at(2)]);
    expect((await store.read({ chains: ['testchain'] })).samples).toHaveLength(2);
    expect((await store.read({ since: at(1) })).samples).toHaveLength(2);
  });
});

describe('the file store', () => {
  const fresh = () => join(mkdtempSync(join(tmpdir(), 'liveness-')), 'nested', 'liveness.jsonl');

  it('reads nothing, without creating anything, when nothing was recorded', async () => {
    const path = fresh();
    expect(await new FileLivenessHistory(path).read()).toEqual({ samples: [], skipped: 0 });
  });

  it('appends, so a sample never rewrites the ones before it', async () => {
    const path = fresh();
    const store = new FileLivenessHistory(path);
    await store.record([sample(0, [up('a')])]);
    const before = readFileSync(path, 'utf8');
    await store.record([sample(1, [up('a')])]);

    expect(readFileSync(path, 'utf8').startsWith(before)).toBe(true);
    expect((await store.read()).samples).toHaveLength(2);
  });

  it('counts an interrupted append as a gap instead of failing every later read', async () => {
    const path = fresh();
    const store = new FileLivenessHistory(path);
    await store.record([sample(0, [up('a')])]);
    appendFileSync(path, '{"at":"2026-10-01T01:00:00.000Z","chain":"testch');
    appendFileSync(path, `\n${JSON.stringify(sample(2, [up('a')]))}\n`);
    appendFileSync(path, '{"valid":"json, but not a sample"}\n');

    const read = await store.read();
    expect(read.samples.map((s) => s.at)).toEqual([at(0), at(2)]);
    expect(read.skipped).toBe(2);
    expect(summarizeHistory(read).completeness.note).toContain('2 records could not be read');
  });

  it('honours SINGULARITY_LIVENESS_HISTORY', async () => {
    const path = fresh();
    const previous = process.env.SINGULARITY_LIVENESS_HISTORY;
    process.env.SINGULARITY_LIVENESS_HISTORY = path;
    try {
      await new FileLivenessHistory().record([sample(0, [up('a')])]);
      expect(readFileSync(path, 'utf8')).toContain('"testchain"');
    } finally {
      if (previous === undefined) delete process.env.SINGULARITY_LIVENESS_HISTORY;
      else process.env.SINGULARITY_LIVENESS_HISTORY = previous;
    }
  });
});

describe('what a history can say', () => {
  it('says there is nothing, rather than that everything is fine, when nothing was recorded', () => {
    const report = summarize([]);
    expect(report.chains).toEqual([]);
    expect(report.completeness.kind).toBe('failed');
  });

  it('calls an endpoint seen twice unproven, not healthy', () => {
    const report = summarize([sample(0, [up('a'), up('b')]), sample(1, [up('a'), up('b')])]);
    expect(report.chains[0]!.endpoints.map((e) => e.verdict)).toEqual(['unproven', 'unproven']);
    expect(report.chains[0]!.findings.join(' ')).toContain('not a history');
  });

  it('calls a steady endpoint healthy', () => {
    const samples = [0, 1, 2, 3].map((h) => sample(h, [up('a'), up('b')]));
    const chain = summarize(samples).chains[0]!;
    expect(chain.endpoints.map((e) => e.verdict)).toEqual(['healthy', 'healthy']);
    expect(chain.failoverHeld).toBe(4);
    expect(chain.findings).toEqual([]);
  });

  it('does not call one failed request a dead endpoint', () => {
    const samples = [sample(0, [up('a'), up('b')]), sample(1, [up('a'), up('b')]), sample(2, [up('a'), up('b')]), sample(3, [up('a'), down('b')])];
    const b = summarize(samples).chains[0]!.endpoints.find((e) => e.host === 'b')!;
    expect(b.verdict).toBe('silent');
    expect(b.silentSince).toBe(at(3));
    expect(b.lastAnswered).toBe(at(2));
    expect(b.lastError).toBe('fetch failed');
  });

  it('does not call three failures inside an hour dead either', () => {
    const samples = [sample(0, [up('a'), up('b')]), ...[1, 1.2, 1.4].map((h) => sample(h, [up('a'), down('b')]))];
    expect(summarize(samples).chains[0]!.endpoints.find((e) => e.host === 'b')!.verdict).toBe('silent');
  });

  it('calls an endpoint dead after three failures spanning a day', () => {
    const samples = [sample(0, [up('a'), up('b')]), ...[1, 13, 25].map((h) => sample(h, [up('a'), down('b')]))];
    expect(summarize(samples).chains[0]!.endpoints.find((e) => e.host === 'b')!.verdict).toBe('dead');
  });

  it('names the endpoint failover rested on', () => {
    const samples = [sample(0, [up('a'), up('b')]), sample(1, [up('a'), down('b')]), sample(2, [up('a'), up('b')]), sample(3, [up('a'), up('b')])];
    const chain = summarize(samples).chains[0]!;
    const a = chain.endpoints.find((e) => e.host === 'a')!;
    expect(a.verdict).toBe('load-bearing');
    expect(a.soleAnswerer).toBe(1);
    expect(chain.failoverHeld).toBe(3);
    expect(chain.findings.join(' ')).toContain('a was the only endpoint answering in 1 of 4 samples');
  });

  it('calls an endpoint that is usually behind lagging, and says what that does to reads', () => {
    const samples = [0, 1, 2].map((h) => sample(h, [up('a', { ageSeconds: 5 }), up('b', { ageSeconds: 600 })]));
    const chain = summarize(samples).chains[0]!;
    const b = chain.endpoints.find((e) => e.host === 'b')!;
    expect(b.verdict).toBe('lagging');
    expect(b.medianBehindSeconds).toBe(595);
    expect(chain.findings.join(' ')).toContain('b is usually 10m behind');
  });

  it('calls an endpoint that answers four times in five flaky', () => {
    const samples = [0, 1, 2, 3, 5].map((h, i) => sample(h, [up('a'), up('b'), i === 2 ? down('c') : up('c')]));
    expect(summarize(samples).chains[0]!.endpoints.find((e) => e.host === 'c')!.verdict).toBe('flaky');
  });

  it('dates a stop to the interval it happened in, not to its end', () => {
    const samples = [sample(0, [up('a'), up('b')]), sample(1, [up('a'), up('b')]), sample(5, [down('a'), down('b')]), sample(6, [down('a'), down('b')])];
    const chain = summarize(samples).chains[0]!;
    expect(chain.latest).toBe('down');
    expect(chain.lastLive).toBe(at(1));
    expect(chain.degradedSince).toBe(at(5));
    expect(chain.degradedBeforeWindow).toBe(false);
    expect(chain.findings[0]).toContain('down now, and not live since');
    expect(chain.findings[0]).toContain('somewhere in that interval');
  });

  it('does not date a stop it never saw', () => {
    const samples = [0, 1, 2].map((h) => sample(h, [down('a'), down('b')]));
    const chain = summarize(samples).chains[0]!;
    expect(chain.lastLive).toBeUndefined();
    expect(chain.degradedBeforeWindow).toBe(true);
    expect(chain.findings[0]).toContain('before this history');
  });

  it('says when the configured endpoints have rotted out from under the failover they assert', () => {
    const samples = [sample(0, [up('a.example'), up('b.example')]), ...[1, 13, 25].map((h) => sample(h, [up('a.example'), down('b.example')]))];
    const chain = summarize(samples, [spec(['https://a.example/key', 'https://b.example'])]).chains[0]!;
    const findings = chain.findings.join(' ');

    expect(chain.endpoints.every((e) => e.configured)).toBe(true);
    expect(findings).toContain('b.example has not answered since');
    expect(findings).toContain('The config asserts failover the chain no longer has.');
  });

  it('says which configured endpoints it has never seen, and which recorded ones are no longer configured', () => {
    const samples = [0, 1, 2].map((h) => sample(h, [up('a.example'), up('old.example')]));
    const chain = summarize(samples, [spec(['https://a.example', 'https://new.example'])]).chains[0]!;

    expect(chain.endpoints.find((e) => e.host === 'old.example')!.configured).toBe(false);
    expect(chain.findings.join(' ')).toContain('new.example is configured but never appears in this history');
  });

  it('reports the largest gap, because nothing inside it is known', () => {
    const samples = [sample(0, [up('a'), up('b')]), sample(1, [up('a'), up('b')]), sample(49, [up('a'), up('b')])];
    const report = summarize(samples);
    expect(report.chains[0]!.largestGapSeconds).toBe(48 * 3600);
    expect(report.completeness.kind).toBe('curated');
    expect(report.completeness.note).toContain('2d');
    expect(report.completeness.note).toContain('invisible here');
  });
});
