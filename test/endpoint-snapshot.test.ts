import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BUILTIN_CHAINS } from '../src/core/chains.js';
import {
  buildSnapshot,
  servedCurrentState,
  snapshotChains,
  type EndpointSnapshot,
} from '../src/core/endpoint-snapshot.js';
import type { EndpointProbe } from '../src/core/liveness.js';
import type { ChainSpec } from '../src/core/types.js';
import { VERSION } from '../src/version.js';

/**
 * Failover is a guarantee about endpoints that answer, not endpoints that are
 * listed.
 *
 * `registry.test.ts` holds that every mainnet lists at least two. That held
 * while Ethereum answered from one of three: llamarpc served Cloudflare 525s,
 * and Ankr started requiring an API key and reported it inside an HTTP 200.
 * Nothing here can ask the network without making CI flaky, so the network is
 * asked by `npm run snapshot:endpoints` and its answer is committed. These
 * tests hold the configuration to that answer.
 *
 * If one fails after a config change, run `npm run snapshot:endpoints` and
 * read the diff before committing it. A line going from `"current": true` to
 * `false` is an endpoint dying.
 */

const snapshot = JSON.parse(
  readFileSync(join(__dirname, 'endpoint-snapshot.json'), 'utf8'),
) as EndpointSnapshot;

describe('the committed endpoint snapshot', () => {
  it('was taken for this release', () => {
    // A release is when somebody should look at the endpoints. A version bump
    // without a fresh snapshot would carry the last release's evidence forward.
    expect(snapshot.version).toBe(VERSION);
  });

  it('describes exactly the endpoints that are configured', () => {
    // An endpoint added without a snapshot was never seen to answer. One
    // removed without a snapshot leaves evidence about a list that no longer exists.
    const configured = Object.fromEntries(snapshotChains(BUILTIN_CHAINS).map((chain) => [chain.id, [...chain.rpc].sort()]));
    const recorded = Object.fromEntries(
      Object.entries(snapshot.chains).map(([id, chain]) => [id, Object.keys(chain.endpoints).sort()]),
    );
    expect(recorded).toEqual(configured);
  });

  it('shows every mainnet configured with failover actually having it', () => {
    const thin = Object.entries(snapshot.chains)
      .filter(([, chain]) => !chain.testnet && Object.keys(chain.endpoints).length >= 2)
      .filter(([, chain]) => Object.values(chain.endpoints).filter((e) => e.current).length < 2)
      .map(([id, chain]) => ({
        id,
        failing: Object.entries(chain.endpoints)
          .filter(([, e]) => !e.current)
          .map(([url, e]) => `${url}: ${e.error ?? 'answered with a head that was not current'}`),
      }));

    expect(thin).toEqual([]);
  });
});

describe('taking a snapshot', () => {
  const chain = (over: Partial<ChainSpec> = {}): ChainSpec => ({
    id: 'testchain',
    name: 'Test Chain',
    family: 'evm',
    chainId: 1,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpc: ['https://one.example/', 'https://two.example/', 'https://three.example/', 'https://four.example/'],
    ...over,
  });

  const probe = (over: Partial<EndpointProbe>): EndpointProbe => ({ host: 'x', ok: true, ms: 10, height: 1, ageSeconds: 5, ...over });

  it('records standing, not readings, so the diff changes only when standing does', () => {
    const target = chain();
    const taken = buildSnapshot(
      '9.9.9',
      [target],
      () => [
        probe({}),
        probe({ ageSeconds: undefined }),
        probe({ ageSeconds: 86_400 }),
        probe({ ok: false, height: undefined, ageSeconds: undefined, error: 'HTTP request failed.\n\nStatus: 525\nURL: https://four.example/' }),
      ],
      new Date('2026-10-02T00:00:00Z'),
    );

    expect(taken).toEqual({
      version: '9.9.9',
      takenAt: '2026-10-02T00:00:00.000Z',
      chains: {
        testchain: {
          family: 'evm',
          testnet: false,
          endpoints: {
            'https://one.example/': { ok: true, current: true },
            // Undated is not current: it cannot show that it is.
            'https://two.example/': { ok: true, current: false },
            // Answering with yesterday's head is not somewhere to fail over to.
            'https://three.example/': { ok: true, current: false },
            'https://four.example/': { ok: false, current: false, error: 'HTTP request failed.' },
          },
        },
      },
    });
  });

  it('judges currency by the family, so Bitcoin is not called stale between blocks', () => {
    expect(servedCurrentState({ ok: true, ageSeconds: 3_600 }, 'utxo')).toBe(true);
    expect(servedCurrentState({ ok: true, ageSeconds: 3_600 }, 'svm')).toBe(false);
  });

  it('leaves out chains with no public endpoint', () => {
    const own = chain({ id: 'own', requiresOwnNode: true, rpc: ['http://127.0.0.1:8650'] });
    expect(snapshotChains([chain(), own]).map((c) => c.id)).toEqual(['testchain']);
    expect(snapshot.chains).not.toHaveProperty('tessarq');
  });
});
