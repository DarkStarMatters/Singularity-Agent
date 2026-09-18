import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  classify,
  describeAge,
  probeEndpoint,
  runSerializedByHost,
  type ChainTip,
  type EndpointProbe,
} from '../src/core/liveness.js';
import { evmAdapter } from '../src/adapters/evm.js';
import type { ChainSpec } from '../src/core/types.js';

/**
 * Reachability and liveness are different questions, and only one of them was
 * ever asked.
 *
 * `doctor` called an endpoint healthy when a request to it did not throw.
 * Polygon zkEVM answers every request, reports chain id 1101, and served a head
 * block 76 days old — it is excluded from this tool for that reason, and it
 * would have passed the old check on the day it was excluded. The cases below
 * are the ones that produce a wrong answer while looking fine, so they are unit
 * tests rather than things to be noticed again later.
 */

const chain = (over: Partial<ChainSpec> = {}): ChainSpec => ({
  id: 'testchain',
  name: 'Test Chain',
  family: 'evm',
  chainId: 1,
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpc: ['https://one.example', 'https://two.example'],
  ...over,
});

const probe = (over: Partial<EndpointProbe> = {}): EndpointProbe => ({
  host: 'one.example',
  ok: true,
  ms: 10,
  height: 100,
  ageSeconds: 5,
  ...over,
});

describe('a head old enough that the answer is not current state', () => {
  it('calls a chain stale when every endpoint is far behind, however well it answers', () => {
    const seventySixDays = 76 * 24 * 3600;

    const result = classify(chain(), [
      probe({ host: 'a.example', ageSeconds: seventySixDays }),
      probe({ host: 'b.example', ageSeconds: seventySixDays + 30 }),
    ]);

    expect(result.status).toBe('stale');
    expect(result.answering).toBe(2);
    expect(result.notes[0]).toContain('historical state wearing a current-state label');
  });

  it('does not call a chain stale for being a few blocks behind', () => {
    const result = classify(chain(), [probe({ ageSeconds: 14 }), probe({ ageSeconds: 26 })]);
    expect(result.status).toBe('live');
  });

  it('measures staleness per family, since ten minutes means opposite things', () => {
    const tenMinutes = 600;

    expect(classify(chain({ family: 'utxo' }), [probe({ ageSeconds: tenMinutes })]).status).not.toBe(
      'stale',
    );
    expect(classify(chain({ family: 'svm' }), [probe({ ageSeconds: tenMinutes })]).status).toBe(
      'stale',
    );
  });
});

describe('a head that cannot be dated', () => {
  it('reports undatable rather than live when nothing timestamps the head', () => {
    const result = classify(chain(), [
      probe({ ageSeconds: undefined }),
      probe({ ageSeconds: undefined }),
    ]);

    expect(result.status).toBe('undatable');
    expect(result.ageSeconds).toBeUndefined();
  });

  /**
   * An unclamped negative age is smaller than every threshold in the module, so
   * a head dated in the future would read as fresher than a genuinely fresh
   * one. Bitcoin permits a timestamp two hours ahead of network time and
   * testnet uses the room, so this is a real chain's real behaviour.
   */
  it('reports a head dated well into the future as skewed, not as fresh', () => {
    const result = classify(chain({ family: 'utxo' }), [probe({ ageSeconds: -6171 })]);

    expect(result.status).toBe('skewed');
    expect(result.notes[0]).toContain('in the future');
  });

  it('absorbs ordinary clock skew instead of ranking it above a current head', () => {
    const result = classify(chain(), [probe({ ageSeconds: -1 }), probe({ ageSeconds: 3 })]);

    expect(result.status).toBe('live');
    expect(result.ageSeconds).toBe(0);
    expect(result.spreadSeconds).toBe(3);
  });
});

describe('failover, which is about endpoints that answer rather than endpoints that exist', () => {
  it('is not satisfied by a second endpoint that does not answer', () => {
    const result = classify(chain(), [probe(), probe({ host: 'two.example', ok: false })]);

    expect(result.status).toBe('single');
    expect(result.notes[0]).toContain('leaving no failover');
  });

  it('separates a chain nobody answers for from one endpoint answering', () => {
    const dead = classify(chain(), [probe({ ok: false }), probe({ ok: false })]);
    expect(dead.status).toBe('down');
    expect(dead.ageSeconds).toBeUndefined();
  });

  /**
   * Failover takes whichever endpoint answers first, so one badly lagging
   * endpoint makes reads stale intermittently — which is harder to notice than
   * a chain that is stale always.
   */
  it('flags endpoints whose heads are far enough apart to change the answer', () => {
    const result = classify(chain(), [
      probe({ host: 'fresh.example', ageSeconds: 4 }),
      probe({ host: 'behind.example', ageSeconds: 900 }),
    ]);

    expect(result.status).toBe('lagging');
    expect(result.notes[0]).toContain('behind.example');
    expect(result.spreadSeconds).toBe(896);
  });
});

describe('probing one endpoint means probing one endpoint', () => {
  it('hands the reader a chain narrowed to the endpoint under test', async () => {
    const seen: string[][] = [];

    await probeEndpoint(chain(), 'https://two.example', async (narrowed) => {
      seen.push(narrowed.rpc);
      return { height: 7 };
    });

    expect(seen).toEqual([['https://two.example']]);
  });

  it('turns a throw into a failed probe rather than losing the other endpoints', async () => {
    const result = await probeEndpoint(chain(), 'https://two.example', async () => {
      throw new Error('handshake failed');
    });

    expect(result).toMatchObject({ ok: false, host: 'two.example', error: 'handshake failed' });
  });

  it('keeps the host and drops the path, which may carry an API key', async () => {
    const result = await probeEndpoint(
      chain(),
      'https://rpc.example/v2/secret-key',
      async (): Promise<ChainTip> => ({ height: 1 }),
    );

    expect(result.host).toBe('rpc.example');
  });
});

describe('the sweep must not become the outage it reports', () => {
  /**
   * `rest.cosmos.directory` serves nine of the Cosmos chains here. Probing all
   * of them at once asks one host nine simultaneous questions and reports
   * whatever it rate-limits as down — the Sei near-miss, where a probe bug
   * nearly kept a healthy chain out of a release.
   */
  it('never has two requests in flight against the same host', async () => {
    const inFlight = new Map<string, number>();
    let worst = 0;

    const jobs = [
      { host: 'shared.example', id: 1 },
      { host: 'shared.example', id: 2 },
      { host: 'shared.example', id: 3 },
      { host: 'other.example', id: 4 },
    ];

    await runSerializedByHost(
      jobs,
      (job) => job.host,
      async (job) => {
        const now = (inFlight.get(job.host) ?? 0) + 1;
        inFlight.set(job.host, now);
        worst = Math.max(worst, now);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight.set(job.host, now - 1);
        return job.id;
      },
    );

    expect(worst).toBe(1);
  });

  it('returns results in the order they were asked for, not the order they arrived', async () => {
    const results = await runSerializedByHost(
      [
        { host: 'slow.example', id: 'first' },
        { host: 'fast.example', id: 'second' },
      ],
      (job) => job.host,
      async (job) => {
        await new Promise((resolve) => setTimeout(resolve, job.id === 'first' ? 20 : 1));
        return job.id;
      },
    );

    expect(results).toEqual(['first', 'second']);
  });
});

describe('an EVM client is only reusable for the endpoints it was built with', () => {
  afterEach(() => vi.unstubAllGlobals());

  /**
   * The client cache was keyed on chain id alone, and the transport is a
   * fallback fixed at construction over whatever `rpc` held then. So the second
   * caller — `doctor`, handing over a chain narrowed to one endpoint — got the
   * first caller's transport and contacted the first endpoint instead.
   *
   * Every probe then described endpoint one, and a chain with three configured
   * endpoints reported three healthy ones after contacting a single host. That
   * is the failover guarantee appearing to hold exactly where it does not, and
   * it reaches users too: `SINGULARITY_RPC_<CHAIN>` rewrites `rpc` and was
   * ignored once anything had warmed the map.
   */
  it('contacts the endpoint it was given rather than the one cached under the chain id', async () => {
    const contacted: string[] = [];

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        contacted.push(new URL(String(url)).host);
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: {
              number: '0x1',
              hash: `0x${'11'.repeat(32)}`,
              parentHash: `0x${'22'.repeat(32)}`,
              timestamp: '0x66000000',
              transactions: [],
              uncles: [],
              nonce: '0x0000000000000000',
              sha3Uncles: `0x${'33'.repeat(32)}`,
              logsBloom: `0x${'00'.repeat(256)}`,
              transactionsRoot: `0x${'44'.repeat(32)}`,
              stateRoot: `0x${'55'.repeat(32)}`,
              receiptsRoot: `0x${'66'.repeat(32)}`,
              miner: `0x${'77'.repeat(20)}`,
              difficulty: '0x0',
              totalDifficulty: '0x0',
              extraData: '0x',
              size: '0x220',
              gasLimit: '0x1c9c380',
              gasUsed: '0x0',
              baseFeePerGas: '0x7',
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
    );

    const id = `cache-probe-${Date.now()}`;
    await evmAdapter.getBlock(chain({ id, rpc: ['https://first.example'] }), 'latest');
    await evmAdapter.getBlock(chain({ id, rpc: ['https://second.example'] }), 'latest');

    expect(contacted).toContain('first.example');
    expect(contacted).toContain('second.example');
  });
});

describe('an age a person can read', () => {
  it('switches units rather than printing six-figure seconds', () => {
    expect(describeAge(45)).toBe('45s');
    expect(describeAge(600)).toBe('10m');
    expect(describeAge(7200)).toBe('2h');
    expect(describeAge(76 * 24 * 3600)).toBe('76d');
  });
});
