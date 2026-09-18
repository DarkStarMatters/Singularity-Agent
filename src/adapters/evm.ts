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
  TransactionHistory,
  TransferParams,
} from '../core/adapter.js';
import type {
  BalanceEntry,
  ChainSpec,
  FeeEstimate,
  HistoryEntry,
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
import { decodeCalldata, decodeLogs, ERC20_ABI } from '../core/abi.js';
import { knownTokens, tokenBySymbol } from '../core/tokens.js';
import { completeness, sanitizeOnchainText } from '../core/envelope.js';
import { checkImpersonation } from '../core/impersonation.js';
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

interface EtherscanRow {
  hash: string;
  from?: string;
  to?: string;
  value?: string;
  timeStamp?: string;
  blockNumber?: string;
  isError?: string;
  txreceipt_status?: string;
}

interface EtherscanList {
  status?: string;
  message?: string;
  result?: EtherscanRow[] | string;
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
 *
 * The last clause is the one that had to be learned the hard way. Some
 * endpoints do not say anything at all: asked for a balance at a block they no
 * longer hold, they answer  — an empty result where a quantity belongs —
 * and the client fails decoding it. That surfaced as a viem stack trace under
 * an RPC_ERROR, which tells a user that something broke rather than that this
 * endpoint cannot serve that block. Mode's public endpoint does exactly this,
 * and it is a claim about the state, not about the connection.
 */
const PRUNED_STATE =
  /missing trie node|state (?:is )?not available|state (?:is )?unavailable|state pruning|archive|header not found|block not found|old block|historical state|decode zero data|zero data \("0x"\)|returned no data/i;

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

/**
 * The OP-stack gas price oracle, at the same address on every chain that has one.
 *
 * A rollup charges twice: once for execution on the L2, and once for posting the
 * transaction's bytes to Ethereum. Only the first is in `gasPrice`, which makes
 * "what a simple transfer costs right now" wrong by whatever the second happens
 * to be — and *how* wrong moves with Ethereum rather than with the L2, so it
 * cannot be estimated once and remembered. Measured across the OP-stack chains
 * here, the L1 share ranged from a rounding error to 249x the L2 fee on the same
 * afternoon.
 */
const GAS_PRICE_ORACLE = '0x420000000000000000000000000000000000000F' as const;

/**
 * A stand-in for the transaction being priced: roughly the RLP of a signed
 * native transfer. The fee depends on the byte count, so a fixed sample gives a
 * fixed approximation rather than a quote — which is what a fee *estimate* is,
 * and the note says so.
 */
const SAMPLE_TRANSFER_BYTES = `0x${'f8'.padEnd(220, 'a')}` as const;

/**
 * What posting this transaction to Ethereum costs, or nothing on a chain that
 * does not work that way.
 *
 * Probed rather than configured. A registry flag saying "this one is a rollup"
 * is a hand-maintained fact that goes stale; the oracle either answers or it
 * does not, and a chain without one is an L1 whose fee is already complete.
 */
async function l1DataFee(chain: ChainSpec): Promise<bigint> {
  try {
    const client = clientFor(chain);
    const fee = await client.readContract({
      address: GAS_PRICE_ORACLE,
      abi: parseAbi(['function getL1Fee(bytes) view returns (uint256)']),
      functionName: 'getL1Fee',
      args: [SAMPLE_TRANSFER_BYTES],
    });
    return typeof fee === 'bigint' ? fee : 0n;
  } catch {
    // No oracle, or one that will not answer. Either way the L2 fee is the
    // whole fee as far as this tool can show — and saying so by adding zero is
    // better than failing a fee estimate over a component that may not exist.
    return 0n;
  }
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
        const [balance, decimals, symbol, name] = await Promise.all([
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
          // Tolerant, unlike the three above, and deliberately so: `name()` is
          // optional in practice and plenty of live tokens do not implement it.
          // A token with no name still has a balance, and failing the entry
          // over a missing label would turn a cosmetic gap into a hole in the
          // holdings list — the exact trade roadmap 1.1 was written about.
          target.name !== undefined
            ? Promise.resolve(target.name)
            : (client
                .readContract({
                  address: target.address,
                  abi: ERC20_ABI,
                  functionName: 'name',
                  ...atArg,
                })
                .catch(() => undefined) as Promise<string | undefined>),
        ]);

        // A curated target carries our own symbol; anything else was just read
        // off the contract, so whoever deployed it wrote that string.
        const fromChain = target.symbol === undefined;
        const safeSymbol = fromChain
          ? sanitizeOnchainText(symbol, shortAddress(target.address, 6, 4))
          : symbol;

        // The long name is the same kind of string as the symbol and gets the
        // same treatment. Empty rather than absent means the contract answered
        // with nothing, which is not a name.
        const safeName =
          target.name !== undefined
            ? target.name
            : sanitizeOnchainText(name, '') || undefined;

        // ...and a string the deployer chose can be a string we already know.
        // Only worth asking about text read off the chain: a curated entry is
        // the thing being impersonated, not the impersonator.
        const impersonation = fromChain
          ? checkImpersonation(chain, {
              symbol: safeSymbol,
              name: safeName,
              address: target.address,
            })
          : undefined;

        return {
          chain: chain.id,
          address: owner,
          token: {
            address: target.address,
            symbol: safeSymbol,
            name: safeName,
            decimals: Number(decimals),
            native: false,
            ...(fromChain ? { untrusted: true as const } : {}),
            ...(impersonation ? { impersonation } : {}),
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

  /**
   * An address's transactions, via an Etherscan-class indexer.
   *
   * This is the one family that cannot answer from its own node. `eth_getLogs`
   * finds events, not an account's transactions, and no JSON-RPC method
   * enumerates "what did this address do" — it takes an index nobody serves for
   * free. So this needs a key, and the important behaviour is what happens
   * without one.
   *
   * It does not return an empty list. An empty list is a claim, and the claim
   * it makes — this address has no history — is the one thing this function
   * cannot possibly know while unconfigured. It returns `failed` with the
   * variable to set. Every caller that respects `completeness` then reports
   * "unavailable" instead of "no activity", which was the entire point of
   * putting this behind a key rather than guessing.
   */
  async getHistory(chain, address, options) {
    const owner = requireAddress(chain, address);
    const limit = Math.min(Math.max(options?.limit ?? 25, 1), 100);
    const key = process.env.SINGULARITY_ETHERSCAN_KEY?.trim();

    const unavailable = (why: string): TransactionHistory => ({
      chain: chain.id,
      address: owner,
      entries: [],
      completeness: completeness.failed(why),
    });

    if (!key) {
      return unavailable(
        `History for an EVM address needs an indexer, and none is configured, so nothing is known about this address. This is not "no activity" — it is no answer. Set SINGULARITY_ETHERSCAN_KEY to a key from etherscan.io; one key serves every supported EVM chain through their V2 API.`,
      );
    }

    if (chain.chainId === undefined) {
      return unavailable(`${chain.name} has no numeric chain id, so the indexer cannot be addressed.`);
    }

    const page = Number(options?.cursor ?? 1) || 1;
    const url = new URL('https://api.etherscan.io/v2/api');
    url.searchParams.set('chainid', String(chain.chainId));
    url.searchParams.set('module', 'account');
    url.searchParams.set('action', 'txlist');
    url.searchParams.set('address', owner);
    url.searchParams.set('page', String(page));
    url.searchParams.set('offset', String(limit));
    url.searchParams.set('sort', 'desc');
    url.searchParams.set('apikey', key);

    let payload: EtherscanList;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      payload = (await response.json()) as EtherscanList;
    } catch (err) {
      return unavailable(
        `The indexer did not answer for ${chain.name}: ${err instanceof Error ? err.message : String(err)}. Nothing is known about this address's history.`,
      );
    }

    // "No transactions found" is a real empty history and the only case where
    // an empty list means what it looks like. Everything else is a failure
    // wearing the same shape, so the two are told apart here rather than by
    // whoever reads the result.
    const empty = /no transactions found/i.test(String(payload.message ?? ''));

    if (payload.status !== '1' && !empty) {
      return unavailable(
        `The indexer refused for ${chain.name}: ${String(payload.result ?? payload.message ?? 'no reason given')}. Nothing is known about this address's history — the key may not cover this chain.`,
      );
    }

    const rows = Array.isArray(payload.result) ? payload.result : [];

    const entries: HistoryEntry[] = rows.map((row) => {
      const from = row.from?.toLowerCase();
      const to = row.to?.toLowerCase();
      const self = owner.toLowerCase();
      const direction =
        from === self && to === self ? 'self' : from === self ? 'out' : to === self ? 'in' : 'unknown';
      const moved = nativeAmount(BigInt(row.value ?? '0'), chain);
      const failed = row.isError === '1' || row.txreceipt_status === '0';

      return {
        hash: row.hash,
        status: failed ? ('failed' as const) : ('success' as const),
        direction,
        value: moved,
        summary: failed
          ? `Failed transaction, ${moved.formatted} ${chain.nativeCurrency.symbol} not moved.`
          : direction === 'in'
            ? `Received ${moved.formatted} ${chain.nativeCurrency.symbol}.`
            : direction === 'out'
              ? `Sent ${moved.formatted} ${chain.nativeCurrency.symbol}.`
              : `${moved.formatted} ${chain.nativeCurrency.symbol} moved.`,
        ...(row.timeStamp
          ? { timestamp: new Date(Number(row.timeStamp) * 1000).toISOString() }
          : {}),
        ...(row.blockNumber ? { blockNumber: Number(row.blockNumber) } : {}),
        ...(to ? { counterparty: direction === 'in' ? row.from : row.to } : {}),
        ...(explorerUrl(chain, 'tx', row.hash)
          ? { explorerUrl: explorerUrl(chain, 'tx', row.hash) as string }
          : {}),
      };
    });

    const scope =
      " Outer transactions only: an internal transfer or a token movement made by a contract this address called is not a transaction of its own and will not appear here.";

    return {
      chain: chain.id,
      address: owner,
      entries,
      completeness:
        entries.length === limit
          ? completeness.paged(entries.length, `Page ${page} of ${entries.length}.${scope}`)
          : completeness.exhaustive(
              `Every transaction the indexer holds for this address${entries.length ? '' : ', which is none'}.${scope}`,
            ),
      ...(entries.length === limit ? { cursor: String(page + 1) } : {}),
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
      // Calldata is what was asked for; logs are what happened. On anything
      // that routed through an aggregator those are different answers, and
      // the second one is usually the question.
      const events = decodeLogs(receipt?.logs ?? []);
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
        ...(events.length ? { events } : {}),
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
      const execution = maxFee * SIMPLE_TRANSFER_GAS;
      const posting = await l1DataFee(chain);

      return {
        chain: chain.id,
        simpleTransfer: nativeAmount(execution + posting, chain),
        details: {
          maxFeePerGas: `${formatGwei(maxFee)} gwei`,
          maxPriorityFeePerGas: `${formatGwei(priority)} gwei`,
          gasForSimpleTransfer: SIMPLE_TRANSFER_GAS.toString(),
          ...(posting > 0n
            ? {
                l2ExecutionFee: nativeAmount(execution, chain).formatted,
                l1DataFee: nativeAmount(posting, chain).formatted,
              }
            : {}),
        },
        note:
          posting > 0n
            ? 'EIP-1559 estimate from the node, plus what posting the transaction to Ethereum costs — on a rollup that second part is charged too, and it moves with Ethereum rather than with this chain. Priced against a sample transfer, so it is an estimate and not a quote. A token transfer costs roughly 3x a native transfer.'
            : 'EIP-1559 estimate from the node. A token transfer costs roughly 3x a native transfer.',
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
