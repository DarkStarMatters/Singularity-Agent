import {
  createPublicClient,
  http,
  fallback,
  isAddress,
  getAddress,
  encodeFunctionData,
  parseAbi,
  defineChain,
  type PublicClient,
  type Abi,
  type Chain,
} from 'viem';
import { normalize } from 'viem/ens';
import * as viemChains from 'viem/chains';
import type {
  ChainAdapter,
  ContractReadParams,
  StateOptions,
  TransferParams,
} from '../core/adapter.js';
import type {
  BalanceEntry,
  ChainSpec,
  FeeEstimate,
  NormalizedBlock,
  NormalizedTx,
  UnsignedTx,
} from '../core/types.js';
import {
  HistoricalStateUnavailableError,
  InvalidAddressError,
  RpcError,
  SingularityError,
} from '../core/errors.js';
import { amount, explorerUrl, nativeAmount, parseUnits, shortAddress, toIso } from '../core/format.js';
import { decodeCalldata, ERC20_ABI } from '../core/abi.js';
import { knownTokens, tokenBySymbol } from '../core/tokens.js';
import { completeness, sanitizeOnchainText } from '../core/envelope.js';
import { getChain } from '../core/registry.js';

/** 21000 gas — the cost of a bare ETH transfer, used for fee quotes. */
const SIMPLE_TRANSFER_GAS = 21_000n;

/** A token to look up, with whatever metadata we already know about it. */
interface TokenTarget {
  address: `0x${string}`;
  symbol?: string;
  name?: string;
  decimals?: number;
}

const clients = new Map<string, PublicClient>();

/**
 * Borrow contract addresses (ENS universal resolver, multicall3) from viem's own
 * chain definitions, indexed by chain id. We define chains ourselves so users can
 * add arbitrary ones, but there is no reason to re-type what viem already knows.
 */
type ChainContracts = NonNullable<Chain['contracts']>;

let contractIndex: Map<number, { contracts: ChainContracts }> | null = null;

function knownContracts(chainId: number): { contracts: ChainContracts } | undefined {
  if (!contractIndex) {
    contractIndex = new Map();
    for (const candidate of Object.values(viemChains)) {
      const definition = candidate as Partial<Chain>;
      if (typeof definition?.id === 'number' && definition.contracts) {
        contractIndex.set(definition.id, { contracts: definition.contracts });
      }
    }
  }
  return contractIndex.get(chainId);
}

function clientFor(chain: ChainSpec): PublicClient {
  const cached = clients.get(chain.id);
  if (cached) return cached;

  const viemChain = defineChain({
    id: Number(chain.chainId),
    name: chain.name,
    nativeCurrency: chain.nativeCurrency,
    rpcUrls: { default: { http: chain.rpc } },
    ...(chain.explorer
      ? { blockExplorers: { default: { name: 'Explorer', url: chain.explorer } } }
      : {}),
    // Without these, viem refuses ENS lookups and cannot batch via multicall3.
    ...(knownContracts(Number(chain.chainId)) ?? {}),
    testnet: chain.testnet ?? false,
  });

  const client = createPublicClient({
    chain: viemChain,
    // Public endpoints drop requests constantly; rank + retry across all of them.
    transport: fallback(
      chain.rpc.map((url) => http(url, { timeout: 15_000, retryCount: 1 })),
      { rank: false },
    ),
    batch: { multicall: true },
  }) as PublicClient;

  clients.set(chain.id, client);
  return client;
}

function requireAddress(chain: ChainSpec, address: string): `0x${string}` {
  if (!isAddress(address)) {
    throw new InvalidAddressError(address, 'EVM', 'Expected 0x followed by 40 hex characters.');
  }
  return getAddress(address);
}

function wrapRpc(chain: ChainSpec, operation: string, err: unknown): never {
  if (err instanceof SingularityError) throw err;
  throw new RpcError(chain.id, `${operation}: ${(err as Error).message}`);
}

/** viem takes the block as a bigint, or omits the field entirely for "latest". */
function atBlockArg(options?: StateOptions): { blockNumber?: bigint } {
  return options?.atBlock === undefined ? {} : { blockNumber: BigInt(options.atBlock) };
}

/**
 * How each EVM client says "I threw that state away".
 *
 * Geth prunes and reports a missing trie node; Erigon and Nethermind report the
 * header or block as not found; hosted providers (Alchemy, Infura, QuickNode)
 * answer with a sentence about archive tiers. None of them are transport
 * failures, and none should be retried against the same endpoint.
 */
const PRUNED_STATE =
  /missing trie node|state (?:is )?not available|state (?:is )?unavailable|state pruning|archive|header not found|block not found|old block|historical state/i;

/**
 * Turn a failed historical read into an answer about *why*.
 *
 * "Header not found" means two very different things — a block the chain has
 * not reached yet, and a block this endpoint stopped keeping state for — and
 * the fix differs (wait vs. switch endpoints). Resolving that needs the chain
 * tip, so it is fetched here, on the failure path only.
 */
async function historicalFailure(
  chain: ChainSpec,
  atBlock: number,
  operation: string,
  err: unknown,
): Promise<never> {
  if (err instanceof SingularityError) throw err;
  const message = (err as Error)?.message ?? '';
  if (!PRUNED_STATE.test(message)) wrapRpc(chain, operation, err);

  const head = await clientFor(chain)
    .getBlockNumber()
    .catch(() => null);

  if (head !== null && BigInt(atBlock) > head) {
    throw new SingularityError(
      'BLOCK_NOT_YET_MINED',
      `Block ${atBlock} does not exist on ${chain.name} yet — the chain tip is ${head}.`,
      'Check the block number. Nothing was read; this is not an empty balance.',
    );
  }

  throw new HistoricalStateUnavailableError(
    chain.id,
    atBlock,
    `The endpoint answered "${message.split('\n')[0]?.slice(0, 160)}".`,
  );
}

export const evmAdapter: ChainAdapter = {
  family: 'evm',

  isValidAddress(_chain, address) {
    return isAddress(address);
  },

  addressExpectation() {
    return 'Expected 0x followed by 40 hex characters.';
  },

  async getNativeBalance(chain, address, options) {
    const owner = requireAddress(chain, address);
    try {
      const raw = await clientFor(chain).getBalance({
        address: owner,
        ...atBlockArg(options),
      });
      return {
        chain: chain.id,
        address: owner,
        token: { ...chain.nativeCurrency, native: true },
        amount: nativeAmount(raw, chain),
        atBlock: options?.atBlock,
      };
    } catch (err) {
      if (options?.atBlock !== undefined) {
        await historicalFailure(chain, options.atBlock, 'eth_getBalance', err);
      }
      wrapRpc(chain, 'eth_getBalance', err);
    }
  },

  async getTokenBalances(chain, address, tokens, options) {
    const owner = requireAddress(chain, address);
    const client = clientFor(chain);
    const atArg = atBlockArg(options);

    // Resolve the caller's list (addresses or symbols) or fall back to the
    // curated set for this chain. Metadata we already know saves two RPC calls
    // per token; anything unknown is read from the contract.
    const targets: TokenTarget[] = tokens?.length
      ? tokens.map((t) => {
          if (isAddress(t)) return { address: getAddress(t) };
          const known = tokenBySymbol(chain.id, t);
          if (known) return { ...known, address: getAddress(known.address) };
          throw new SingularityError(
            'UNKNOWN_TOKEN',
            `"${t}" is neither an address nor a token symbol known on ${chain.id}.`,
            'Pass the contract address directly.',
          );
        })
      : knownTokens(chain.id).map((t) => ({ ...t, address: getAddress(t.address) }));

    if (!targets.length) {
      return {
        entries: [],
        completeness: completeness.curated(
          `No tokens are curated for ${chain.name}, and an EVM chain cannot be enumerated without an indexer, so nothing was checked. This is not evidence the address holds no tokens. Pass \`tokens\` with contract addresses to check specific ones.`,
        ),
      };
    }

    const results = await Promise.allSettled(
      targets.map(async (target): Promise<BalanceEntry> => {
        const [balance, decimals, symbol] = await Promise.all([
          client.readContract({
            address: target.address,
            abi: ERC20_ABI,
            functionName: 'balanceOf',
            args: [owner],
            ...atArg,
          }) as Promise<bigint>,
          target.decimals !== undefined
            ? Promise.resolve(target.decimals)
            : (client.readContract({
                address: target.address,
                abi: ERC20_ABI,
                functionName: 'decimals',
                ...atArg,
              }) as Promise<number>),
          target.symbol !== undefined
            ? Promise.resolve(target.symbol)
            : (client.readContract({
                address: target.address,
                abi: ERC20_ABI,
                functionName: 'symbol',
                ...atArg,
              }) as Promise<string>),
        ]);

        // A curated target carries our own symbol; anything else was just read
        // off the contract, so whoever deployed it wrote that string.
        const fromChain = target.symbol === undefined;
        const safeSymbol = fromChain
          ? sanitizeOnchainText(symbol, shortAddress(target.address, 6, 4))
          : symbol;

        return {
          chain: chain.id,
          address: owner,
          token: {
            address: target.address,
            symbol: safeSymbol,
            name: target.name,
            decimals: Number(decimals),
            native: false,
            ...(fromChain ? { untrusted: true as const } : {}),
          },
          amount: amount(balance, Number(decimals), safeSymbol),
          atBlock: options?.atBlock,
        };
      }),
    );

    // Dropping failures is safe for a current-state scan, but at a past block
    // it is not: a non-archive endpoint rejects *every* target, and the dropped
    // failures would come back as an empty list reading "held no tokens then".
    // A pruning error escapes the filter for exactly that reason.
    if (options?.atBlock !== undefined) {
      for (const result of results) {
        if (result.status !== 'rejected') continue;
        const message = (result.reason as Error)?.message ?? '';
        if (PRUNED_STATE.test(message)) {
          await historicalFailure(chain, options.atBlock, 'eth_call balanceOf', result.reason);
        }
      }
    }

    // A token contract that fails to answer is dropped rather than failing the
    // whole balance call — one dead contract should not hide the other nine.
    // What it must not do is vanish: the count of dropped contracts is the
    // difference between "holds none of these" and "could not tell".
    const answered = results.filter(
      (r): r is PromiseFulfilledResult<BalanceEntry> => r.status === 'fulfilled',
    );
    const unreachable = results.length - answered.length;
    const entries = answered.map((r) => r.value).filter((entry) => entry.amount.raw !== '0');

    const scope = tokens?.length
      ? `the ${targets.length} token(s) you named`
      : `a curated list of ${targets.length} major token(s) on ${chain.name}`;

    const at = options?.atBlock === undefined ? '' : ` at block ${options.atBlock}`;

    return {
      entries,
      completeness:
        unreachable === results.length
          ? completeness.failed(
              `None of the ${results.length} token contract(s) answered${at}, so nothing is known about this address's token holdings. This is not an empty wallet.`,
            )
          : completeness.curated(
              `Covers ${scope}${at} — an EVM chain cannot be enumerated without an indexer, so a token outside this list is invisible here, not absent from the wallet.` +
                (unreachable
                  ? ` ${unreachable} contract(s) did not answer and are unaccounted for.`
                  : ''),
            ),
    };
  },

  async getTransaction(chain, hash) {
    const client = clientFor(chain);
    const txHash = hash as `0x${string}`;

    try {
      const tx = await client.getTransaction({ hash: txHash });
      const receipt = await client
        .getTransactionReceipt({ hash: txHash })
        .catch(() => null);
      const block = tx.blockNumber
        ? await client.getBlock({ blockNumber: tx.blockNumber }).catch(() => null)
        : null;

      const decoded = decodeCalldata(tx.input);
      const value = nativeAmount(tx.value, chain);
      const gasUsed = receipt?.gasUsed ?? tx.gas;
      const effectiveGasPrice = receipt?.effectiveGasPrice ?? tx.gasPrice ?? 0n;

      return {
        chain: chain.id,
        hash: tx.hash,
        status: receipt ? (receipt.status === 'success' ? 'success' : 'failed') : 'pending',
        blockNumber: tx.blockNumber ? Number(tx.blockNumber) : undefined,
        timestamp: toIso(block?.timestamp),
        from: tx.from,
        to: tx.to ?? undefined,
        value,
        fee: nativeAmount(gasUsed * effectiveGasPrice, chain),
        summary: summarizeTx(chain, tx.from, tx.to, value.formatted, decoded.signature),
        decoded,
        explorerUrl: explorerUrl(chain, 'tx', tx.hash),
        raw: {
          nonce: tx.nonce,
          gas: tx.gas.toString(),
          gasUsed: gasUsed.toString(),
          effectiveGasPrice: effectiveGasPrice.toString(),
          type: tx.type,
          logs: receipt?.logs.length ?? 0,
        },
      } satisfies NormalizedTx;
    } catch (err) {
      const message = (err as Error).message;
      if (/not be found|not found/i.test(message)) {
        throw new SingularityError(
          'TX_NOT_FOUND',
          `Transaction ${shortAddress(hash, 10, 8)} was not found on ${chain.name}.`,
          'It may be on a different chain, still in the mempool, or dropped. Try the "resolve" tool to search across chains.',
        );
      }
      wrapRpc(chain, 'eth_getTransactionByHash', err);
    }
  },

  async getBlock(chain, ref) {
    const client = clientFor(chain);
    try {
      const block =
        ref === 'latest' || ref === ''
          ? await client.getBlock()
          : typeof ref === 'number' || /^\d+$/.test(String(ref))
            ? await client.getBlock({ blockNumber: BigInt(ref) })
            : await client.getBlock({ blockHash: String(ref) as `0x${string}` });

      return {
        chain: chain.id,
        number: Number(block.number),
        hash: block.hash ?? '',
        timestamp: toIso(block.timestamp),
        txCount: block.transactions.length,
        parentHash: block.parentHash,
        explorerUrl: explorerUrl(chain, 'block', String(block.number)),
        raw: {
          gasUsed: block.gasUsed.toString(),
          gasLimit: block.gasLimit.toString(),
          baseFeePerGas: block.baseFeePerGas?.toString(),
          miner: block.miner,
        },
      } satisfies NormalizedBlock;
    } catch (err) {
      wrapRpc(chain, 'eth_getBlockByNumber', err);
    }
  },

  async estimateFees(chain) {
    const client = clientFor(chain);
    try {
      const fees = await client.estimateFeesPerGas().catch(async () => ({
        maxFeePerGas: await client.getGasPrice(),
        maxPriorityFeePerGas: 0n,
        gasPrice: undefined,
      }));

      const maxFee = fees.maxFeePerGas ?? 0n;
      const priority = fees.maxPriorityFeePerGas ?? 0n;

      return {
        chain: chain.id,
        simpleTransfer: nativeAmount(maxFee * SIMPLE_TRANSFER_GAS, chain),
        details: {
          maxFeePerGas: `${formatGwei(maxFee)} gwei`,
          maxPriorityFeePerGas: `${formatGwei(priority)} gwei`,
          gasForSimpleTransfer: SIMPLE_TRANSFER_GAS.toString(),
        },
        note: 'EIP-1559 estimate from the node. A token transfer costs roughly 3x a native transfer.',
      } satisfies FeeEstimate;
    } catch (err) {
      wrapRpc(chain, 'eth_feeHistory', err);
    }
  },

  async buildTransfer(chain, params) {
    const to = requireAddress(chain, params.to);
    const from = params.from ? requireAddress(chain, params.from) : undefined;

    if (params.token) {
      return buildTokenTransfer(chain, { ...params, to, from });
    }

    const value = parseUnits(params.amount, chain.nativeCurrency.decimals);
    const symbol = chain.nativeCurrency.symbol;

    return {
      chain: chain.id,
      family: 'evm',
      summary: `Send ${params.amount} ${symbol} to ${shortAddress(to)} on ${chain.name}.`,
      payload: {
        ...(from ? { from } : {}),
        to,
        value: `0x${value.toString(16)}`,
        data: '0x',
        chainId: Number(chain.chainId),
      },
      signingHint:
        'Pass this object to eth_sendTransaction in your wallet, or `cast send` with your own key. Singularity does not sign.',
      warnings: warningsFor(chain, params.amount, symbol),
    } satisfies UnsignedTx;
  },

  async resolveName(chain, name) {
    // ENS lives on Ethereum mainnet; resolve there regardless of the chain asked
    // about, since the resulting address is valid on every EVM chain.
    if (!name.includes('.')) return null;
    const mainnet = chain.chainId === 1 ? chain : getChain('ethereum');
    try {
      // viem returns null for an unregistered name; anything thrown is a real
      // failure and must not be disguised as "no such name".
      return await clientFor(mainnet).getEnsAddress({ name: normalize(name) });
    } catch (err) {
      wrapRpc(mainnet, `ENS resolution of "${name}"`, err);
    }
  },

  async lookupName(chain, address) {
    const mainnet = chain.chainId === 1 ? chain : getChain('ethereum');
    try {
      return await clientFor(mainnet).getEnsName({ address: requireAddress(chain, address) });
    } catch (err) {
      wrapRpc(mainnet, `reverse ENS lookup of ${shortAddress(address)}`, err);
    }
  },

  async readContract(chain, params: ContractReadParams) {
    const address = requireAddress(chain, params.address);
    if (!params.abi || !params.method) {
      throw new SingularityError(
        'MISSING_ABI',
        'An EVM contract read needs both `abi` and `method`.',
        'Example: abi "function balanceOf(address) view returns (uint256)", method "balanceOf".',
      );
    }

    let abi: Abi;
    try {
      abi = parseAbi([params.abi]);
    } catch (err) {
      throw new SingularityError(
        'BAD_ABI',
        `Could not parse ABI "${params.abi}": ${(err as Error).message}`,
        'Use human-readable form, e.g. "function totalSupply() view returns (uint256)".',
      );
    }

    try {
      const result = await clientFor(chain).readContract({
        address,
        abi,
        functionName: params.method,
        args: (params.args ?? []) as unknown[],
        ...atBlockArg(params),
      });
      return result;
    } catch (err) {
      if (params.atBlock !== undefined) {
        await historicalFailure(chain, params.atBlock, `eth_call ${params.method}`, err);
      }
      wrapRpc(chain, `eth_call ${params.method}`, err);
    }
  },
};

async function buildTokenTransfer(
  chain: ChainSpec,
  params: TransferParams & { to: `0x${string}`; from?: `0x${string}` },
): Promise<UnsignedTx> {
  const client = clientFor(chain);
  const known = isAddress(params.token!) ? undefined : tokenBySymbol(chain.id, params.token!);
  const tokenAddress = known ? getAddress(known.address) : requireAddress(chain, params.token!);

  const [decimals, symbol] = await Promise.all([
    known?.decimals !== undefined
      ? Promise.resolve(known.decimals)
      : (client.readContract({
          address: tokenAddress,
          abi: ERC20_ABI,
          functionName: 'decimals',
        }) as Promise<number>),
    known?.symbol
      ? Promise.resolve(known.symbol)
      : (client.readContract({
          address: tokenAddress,
          abi: ERC20_ABI,
          functionName: 'symbol',
        }) as Promise<string>),
  ]).catch((err) => {
    throw new SingularityError(
      'NOT_A_TOKEN',
      `${tokenAddress} did not answer decimals()/symbol() on ${chain.name}: ${(err as Error).message}`,
      'Check the address is an ERC-20 on this specific chain — token addresses differ per chain.',
    );
  });

  const value = parseUnits(params.amount, Number(decimals));
  const data = encodeFunctionData({
    abi: ERC20_ABI,
    functionName: 'transfer',
    args: [params.to, value],
  });

  return {
    chain: chain.id,
    family: 'evm',
    summary: `Send ${params.amount} ${symbol} (${shortAddress(tokenAddress)}) to ${shortAddress(params.to)} on ${chain.name}.`,
    payload: {
      ...(params.from ? { from: params.from } : {}),
      to: tokenAddress,
      value: '0x0',
      data,
      chainId: Number(chain.chainId),
    },
    signingHint:
      'This calls transfer() on the token contract. `to` is the TOKEN address, not the recipient — the recipient is encoded in `data`. Sign with your own wallet.',
    warnings: [
      ...warningsFor(chain, params.amount, symbol),
      ...recipientWarnings(params.to, tokenAddress, params.from, symbol),
      'Verify the token address belongs to the asset you mean. Fake tokens reuse real symbols.',
    ],
  };
}

function warningsFor(chain: ChainSpec, amountStr: string, symbol: string): string[] {
  const warnings = [`This transaction is unsigned. Review every field before signing.`];
  if (chain.testnet) warnings.push(`${chain.name} is a testnet — these ${symbol} have no value.`);
  if (Number(amountStr) === 0) warnings.push('Amount is zero.');
  return warnings;
}

function summarizeTx(
  chain: ChainSpec,
  from: string,
  to: string | null,
  value: string,
  signature?: string,
): string {
  const symbol = chain.nativeCurrency.symbol;
  if (!to) return `Contract deployment from ${shortAddress(from)} on ${chain.name}.`;
  const call = signature ? ` calling ${signature.replace(/^function /, '').split(' returns')[0]}` : '';
  if (value !== '0') {
    return `${shortAddress(from)} sent ${value} ${symbol} to ${shortAddress(to)}${call} on ${chain.name}.`;
  }
  return `${shortAddress(from)} -> ${shortAddress(to)}${call || ' (no value, no known method)'} on ${chain.name}.`;
}

function formatGwei(wei: bigint): string {
  const gwei = Number(wei) / 1e9;
  return gwei < 0.01 ? gwei.toExponential(2) : gwei.toFixed(3).replace(/\.?0+$/, '');
}

// `transfer()` to the token's own contract is almost always a mistake: those tokens
// are unrecoverable unless the contract happens to expose a sweep. Worth flagging
// loudly, since the recipient is buried in calldata where a human won't check it.
function recipientWarnings(
  to: string,
  tokenAddress: string,
  from: string | undefined,
  symbol: string,
): string[] {
  const warnings: string[] = [];
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

  if (same(to, tokenAddress)) {
    warnings.push(
      `Recipient is the ${symbol} contract itself. Tokens sent there are normally unrecoverable — this is very likely a mistake.`,
    );
  }
  if (same(to, '0x0000000000000000000000000000000000000000')) {
    warnings.push(`Recipient is the zero address. This burns the ${symbol}.`);
  }
  if (from && same(to, from)) {
    warnings.push('Sender and recipient are the same address — this transfer does nothing but cost gas.');
  }
  return warnings;
}
