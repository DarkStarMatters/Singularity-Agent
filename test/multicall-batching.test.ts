import { describe, it, expect } from 'vitest';
import { createPublicClient, custom, defineChain, type Chain } from 'viem';
import * as viemChains from 'viem/chains';
import { allChains } from '../src/core/registry.js';
import { ERC20_ABI } from '../src/core/abi.js';

/**
 * A token scan asks `balanceOf` once per token. Routed through Multicall3 that
 * is one round trip instead of N, which is the difference between a scan that
 * works on a public endpoint and one that trips its rate limit.
 *
 * Both halves of that are already true — the client is built with
 * `batch: { multicall: true }` and the reads are issued concurrently — but
 * neither half is sufficient alone, and the second dependency is invisible:
 * viem batches only when the chain definition carries a multicall3 address,
 * and this repo defines its own chains and borrows contracts from viem's
 * registry by chain id. Add an EVM chain viem has never heard of and batching
 * disappears silently, along with ENS. Nothing about the answers changes; they
 * just cost N requests instead of one, on endpoints that ration requests.
 *
 * So the guarantee is held here rather than assumed: every EVM chain must
 * resolve a multicall3 address, and the setting must actually collapse
 * concurrent reads into a single call.
 */

/** Multicall3 is deployed at one address on essentially every chain. */
const CANONICAL = '0xcA11bde05977b3631167028862bE2a173976CA11'.toLowerCase();

type ChainContracts = NonNullable<Chain['contracts']>;

function viemContracts(chainId: number): ChainContracts | undefined {
  for (const candidate of Object.values(viemChains)) {
    const definition = candidate as Partial<Chain>;
    if (definition?.id === chainId && definition.contracts) return definition.contracts;
  }
  return undefined;
}

const evmChains = allChains().filter((chain) => chain.family === 'evm');

describe('multicall3 coverage', () => {
  it('has EVM chains to check', () => {
    expect(evmChains.length).toBeGreaterThan(0);
  });

  it('resolves a multicall3 address for every EVM chain', () => {
    const missing = evmChains
      .filter((chain) => !viemContracts(Number(chain.chainId))?.multicall3?.address)
      .map((chain) => `${chain.id} (chainId ${chain.chainId})`);

    // A chain listed here gets no batching and no ENS, and says nothing about
    // it. Supply the address on the chain spec rather than deleting the name.
    expect(missing).toEqual([]);
  });

  it('uses the canonical Multicall3 deployment, or a named exception', () => {
    // ZKsync Era derives CREATE2 addresses by a different formula, so the
    // deterministic deployment that puts Multicall3 at one address on every
    // other chain does not land there. It is listed rather than skipped: if
    // this address stops matching, deleting the line is what fails.
    const exceptions: Record<string, string> = {
      zksync: '0xf9cda624fbc7e059355ce98a31693d299facd963',
    };

    const odd = evmChains
      .map((chain) => ({
        id: chain.id,
        address: viemContracts(Number(chain.chainId))?.multicall3?.address?.toLowerCase(),
      }))
      .filter((entry) => entry.address && entry.address !== CANONICAL)
      .filter((entry) => entry.address !== exceptions[entry.id])
      .map((entry) => `${entry.id} -> ${entry.address}`);

    // An unexpected address is worth reading deliberately rather than
    // inheriting, so a new one fails here until somebody looks at it.
    expect(odd).toEqual([]);

    // And an exception that stopped being one is equally worth knowing.
    for (const [id, address] of Object.entries(exceptions)) {
      const chain = evmChains.find((candidate) => candidate.id === id);
      if (!chain) continue;
      expect(
        viemContracts(Number(chain.chainId))?.multicall3?.address?.toLowerCase(),
        `${id} no longer needs an exception; delete it`,
      ).toBe(address);
    }
  });
});

describe('the batching setting, which is the half that can be true and do nothing', () => {
  it('collapses concurrent reads into one call', async () => {
    const calls: { method: string; to?: string }[] = [];

    const chain = defineChain({
      id: 1,
      name: 'Test',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: ['http://localhost:0'] } },
      contracts: { multicall3: { address: CANONICAL as `0x${string}` } },
    });

    const client = createPublicClient({
      chain,
      batch: { multicall: true },
      transport: custom(
        {
          async request({ method, params }) {
            const [first] = (params ?? []) as { to?: string }[];
            calls.push({ method, ...(first?.to ? { to: first.to.toLowerCase() } : {}) });
            // The aggregation is what is under test, not the decoding, so the
            // reply is refused rather than forged.
            throw new Error('probe');
          },
        },
        { retryCount: 0 },
      ),
    });

    const tokens = [
      '0x1111111111111111111111111111111111111111',
      '0x2222222222222222222222222222222222222222',
      '0x3333333333333333333333333333333333333333',
      '0x4444444444444444444444444444444444444444',
    ] as const;

    await Promise.allSettled(
      tokens.map((address) =>
        client.readContract({
          address,
          abi: ERC20_ABI,
          functionName: 'balanceOf',
          args: ['0x5555555555555555555555555555555555555555'],
        }),
      ),
    );

    const ethCalls = calls.filter((call) => call.method === 'eth_call');

    expect(ethCalls.length, `4 reads produced ${ethCalls.length} eth_call requests`).toBe(1);
    expect(ethCalls[0]?.to).toBe(CANONICAL);
  });
});
