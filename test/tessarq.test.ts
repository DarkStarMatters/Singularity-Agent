import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  minimumFee,
  parseLosslessJson,
  signedTransferBytes,
  tessarqAdapter,
} from '../src/adapters/tessarq.js';
import { detect } from '../src/core/detect.js';
import { getChain, resetRegistry, sweepChains } from '../src/core/registry.js';
import type { ChainSpec } from '../src/core/types.js';

/**
 * Tessarq, checked against what its node actually sends.
 *
 * The fixtures are responses captured from a local four-validator testnet
 * (`tessarq testnet --validators 4`) after a real 1.5 TSRQ transfer from the
 * faucet, at block 32. They are not reconstructed from the Rust types: the
 * point of having them is that the node's JSON, not a reading of its source,
 * is what the adapter has to parse.
 */

const fixture = (name: string) => readFileSync(new URL(`./fixtures/tessarq/${name}`, import.meta.url), 'utf8');
const BLOCK_32 = fixture('block-32-transfer.json');
const STATUS = fixture('status.json');
const FAUCET = '9331ed4478aebbbf29ff286f14aa5eae785599eab43a94beebd2ac5ae4280804';
const BOB = '0700b7db5238f3baee73c4fea30ef93a3d409367cef06b6bde0676ec25f6c154';

const TESSARQ = getChain('tessarq');

function chain(overrides: Partial<ChainSpec> = {}): ChainSpec {
  return { ...TESSARQ, rpc: ['http://node-a:8650'], ...overrides };
}

/** A node that answers from a table of path -> raw body; anything else is a 404. */
function serve(routes: Record<string, string | ((url: string) => Response)>) {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      const url = String(input);
      calls.push(url);
      const path = new URL(url).pathname;
      const route = routes[path];
      if (typeof route === 'function') return route(url);
      if (route !== undefined) return new Response(route, { status: 200 });
      return new Response('{"error":"not found"}', { status: 404 });
    }),
  );
  return calls;
}

function status(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ ...JSON.parse(STATUS), ...overrides });
}

beforeEach(() => resetRegistry());
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.SINGULARITY_RPC_TESSARQ;
  resetRegistry();
});

describe('parseLosslessJson', () => {
  it('keeps integers past 2^53 exact', () => {
    // The faucet's real balance. JSON.parse reads it as 49995998749999992.
    const body = '{"balance":49995998749999990,"nonce":1,"vesting":null}';
    expect(BigInt(JSON.parse(body).balance)).toBe(49995998749999992n);
    expect(parseLosslessJson(body)).toEqual({ balance: '49995998749999990', nonce: 1, vesting: null });
  });

  it('leaves strings alone, whatever digits and escapes they hold', () => {
    const body = '{"capability":"gpu:12345678901234567, \\"x\\":9999999999999999","n":-12345678901234567,"f":1.5e3}';
    expect(parseLosslessJson(body)).toEqual({
      capability: 'gpu:12345678901234567, "x":9999999999999999',
      n: '-12345678901234567',
      f: 1500,
    });
  });
});

describe('reads', () => {
  it('reads a balance past 2^53 to the unit', async () => {
    serve({ [`/account/${FAUCET}`]: fixture('account-faucet.json') });
    const entry = await tessarqAdapter.getNativeBalance(chain(), FAUCET);
    expect(entry.amount).toMatchObject({ raw: '49995998749999990', decimals: 9, symbol: 'TSRQ' });
  });

  it('accepts a 0x-prefixed address and reports it the way the node writes it', async () => {
    serve({ [`/account/${FAUCET}`]: fixture('account-faucet.json') });
    const entry = await tessarqAdapter.getNativeBalance(chain(), `0x${FAUCET.toUpperCase()}`);
    expect(entry.address).toBe(FAUCET);
  });

  it('refuses a historical read instead of answering with current state', async () => {
    serve({});
    await expect(tessarqAdapter.getNativeBalance(chain(), FAUCET, { atBlock: 5 })).rejects.toMatchObject({
      code: 'HISTORICAL_STATE_UNSUPPORTED',
    });
  });

  it('maps a real block: the certificate hash, its transfer, and its time', async () => {
    serve({ '/status': status(), '/block/32': BLOCK_32 });
    const block = await tessarqAdapter.getBlock(chain(), 32);
    expect(block).toMatchObject({
      number: 32,
      hash: 'a8b3415921df47cf194426e6fc0c4d5384073897fb646ee56c316e3180ae28dc',
      parentHash: '3ee358d76b67d5b073e728cf902016fea5f516009c7f35065d21d2b0adaa5bb0',
      timestamp: '2026-09-29T19:55:11.655Z',
      txCount: 1,
    });
    expect(block.raw).toMatchObject({ chainId: 'tessarq-local', txTypes: ['transfer'], precommits: 3 });
  });

  it('says whether a missing block is in the future or out of memory', async () => {
    serve({ '/status': status({ height: 1325 }) });
    await expect(tessarqAdapter.getBlock(chain(), 5000)).rejects.toThrow(/not been produced yet/);
    await expect(tessarqAdapter.getBlock(chain(), 7)).rejects.toThrow(/not held in this node's memory/);
  });

  it('has no transaction lookup, and says so rather than searching', async () => {
    await expect(tessarqAdapter.getTransaction(chain(), BOB)).rejects.toMatchObject({ code: 'UNSUPPORTED' });
  });

  it('reads the tip, dated, and calls it final', async () => {
    serve({ '/status': status({ height: 1325, last_time_ms: 1790712000000 }) });
    expect(await tessarqAdapter.chainTip!(chain())).toEqual({
      height: 1325,
      timestamp: new Date(1790712000000).toISOString(),
    });
    expect(await tessarqAdapter.finalizedHeight!(chain())).toBe(1325);
  });
});

describe('bridged assets', () => {
  const ASSET = 'aa'.repeat(32);
  const assets = JSON.stringify([{ id: ASSET, symbol: 'USDC', decimals: 6, paused: false }]);

  it('reads every listed asset and calls the list exhaustive', async () => {
    serve({ '/assets': assets, [`/asset/${ASSET}/balance/${BOB}`]: `{"asset":"${ASSET}","owner":"${BOB}","amount":2500000}` });
    const scan = await tessarqAdapter.getTokenBalances(chain(), BOB);
    expect(scan.completeness.kind).toBe('exhaustive');
    expect(scan.entries).toHaveLength(1);
    expect(scan.entries[0]).toMatchObject({
      token: { address: ASSET, symbol: 'USDC', decimals: 6, untrusted: true },
      amount: { raw: '2500000', formatted: '2.5' },
    });
  });

  it('throws when a balance read fails, rather than reporting it as zero', async () => {
    serve({ '/assets': assets });
    await expect(tessarqAdapter.getTokenBalances(chain(), BOB)).rejects.toThrow();
  });

  it('refuses an asset id the chain does not list', async () => {
    serve({ '/assets': assets });
    await expect(tessarqAdapter.getTokenBalances(chain(), BOB, ['bb'.repeat(32)])).rejects.toMatchObject({
      code: 'UNKNOWN_ASSET',
    });
  });
});

describe('network identity', () => {
  it('refuses a node serving a different network than the one configured', async () => {
    serve({ '/status': status(), [`/account/${FAUCET}`]: fixture('account-faucet.json') });
    await expect(
      tessarqAdapter.getNativeBalance(chain({ chainId: 'tessarq-mainnet' }), FAUCET),
    ).rejects.toThrow(/serves chain "tessarq-local", but Tessarq is configured as "tessarq-mainnet"/);
  });

  it('checks the endpoint that answered, when failover moved the read', async () => {
    serve({});
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        const url = new URL(String(input));
        if (url.host === 'node-a:8650') throw new Error('connection refused');
        if (url.pathname === '/status') return new Response(status({ chain_id: 'other-net' }));
        return new Response(fixture('account-faucet.json'));
      }),
    );
    const c = chain({ chainId: 'tessarq-local-2', rpc: ['http://node-a:8650', 'http://node-b:8650'] });
    await expect(tessarqAdapter.getNativeBalance(c, FAUCET)).rejects.toThrow(/node-b:8650.*"other-net"/);
  });
});

describe('fees', () => {
  it('is the flat minimum under protocol version 1', () => {
    expect(minimumFee(10n, 1, signedTransferBytes('tessarq-local', false))).toBe(10n);
  });

  it('matches what a live node charged under protocol version 2', () => {
    // Measured: a transfer on `tessarq-local` after upgrading the testnet to
    // version 2 cost the sender exactly 5,217,774 base units beyond its amount.
    expect(signedTransferBytes('tessarq-local', false)).toBe(5343);
    expect(minimumFee(10n, 2, 5343)).toBe(5_217_774n);
  });

  it('reads the protocol version from the node rather than assuming one', async () => {
    serve({ '/status': status({ protocol_version: 1 }), '/genesis': '{"params":{"min_fee":10}}' });
    expect((await tessarqAdapter.estimateFees(chain())).simpleTransfer?.raw).toBe('10');
    serve({ '/status': status({ protocol_version: 2 }), '/genesis': '{"params":{"min_fee":10}}' });
    expect((await tessarqAdapter.estimateFees(chain())).simpleTransfer?.raw).toBe('5217774');
  });
});

describe('buildTransfer', () => {
  const routes = () => ({
    '/status': status({ protocol_version: 1 }),
    '/genesis': '{"params":{"min_fee":10}}',
    [`/account/${BOB}`]: '{"balance":1500000000,"nonce":0,"vesting":null}',
  });

  it('hands over the tessarq command with the amount in base units', async () => {
    serve(routes());
    const tx = await tessarqAdapter.buildTransfer(chain(), { from: BOB, to: FAUCET, amount: '0.25' });
    expect(tx.payload).toEqual({
      chainId: 'tessarq-local',
      nonce: '0',
      fee: '10',
      payload: { type: 'transfer', to: FAUCET, amount: '250000000' },
    });
    expect(tx.signingHint).toContain(`tessarq transfer --rpc http://node-a:8650 --key <your key file> --to ${FAUCET} --amount 250000000`);
  });

  it('warns when the sender cannot cover amount and fee', async () => {
    serve(routes());
    const tx = await tessarqAdapter.buildTransfer(chain(), { from: BOB, to: FAUCET, amount: '1.5' });
    expect(tx.warnings.some((w) => w.includes('The node will refuse this'))).toBe(true);
  });

  it('refuses a memo rather than dropping it', async () => {
    serve(routes());
    await expect(
      tessarqAdapter.buildTransfer(chain(), { to: FAUCET, amount: '1', memo: 'invoice 7' }),
    ).rejects.toMatchObject({ code: 'MEMO_UNSUPPORTED' });
  });

  it('refuses more precision than TSRQ has', async () => {
    serve(routes());
    await expect(tessarqAdapter.buildTransfer(chain(), { to: FAUCET, amount: '0.0000000001' })).rejects.toThrow(
      /9/,
    );
  });
});

describe('registry and detection', () => {
  it('leaves Tessarq out of sweeps until a node is configured', () => {
    expect(sweepChains().some((c) => c.id === 'tessarq')).toBe(false);
    process.env.SINGULARITY_RPC_TESSARQ = 'http://10.77.0.1:8650,http://10.77.0.2:8650';
    resetRegistry();
    const configured = sweepChains().find((c) => c.id === 'tessarq');
    expect(configured?.rpc).toEqual(['http://10.77.0.1:8650', 'http://10.77.0.2:8650']);
    expect(configured?.rpcSource).toBe('env');
  });

  it('names Tessarq as a reading of 64 hex characters, with or without 0x', () => {
    expect(detect(FAUCET).chains).toContain('tessarq');
    expect(detect(`0x${FAUCET}`).chains).toContain('tessarq');
    expect(detect(FAUCET).reason).toMatch(/Tessarq/);
  });
});
