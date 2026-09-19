import type { ChainAdapter } from '../core/adapter.js';
import { type BudgetBounds, applyBudget, budgetNote, itemBudget } from '../core/budget.js';
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
  completeness,
  sanitizeOnchainDeep,
  sanitizeOnchainText,
  untrustedText,
} from '../core/envelope.js';
import { checkImpersonation } from '../core/impersonation.js';
import {
  HistoricalStateUnavailableError,
  InvalidAddressError,
  RpcError,
  SingularityError,
  UnsupportedOperationError,
} from '../core/errors.js';
import {
  amount,
  baseUnits,
  explorerUrl,
  nativeAmount,
  parseUnits,
  shortAddress,
} from '../core/format.js';
import { fetchWithFailover, fetchWithFailoverDetail } from '../core/http.js';
import { bech32ToBytes, bytesToBech32 } from '../core/address-codec.js';

/**
 * Entries one history page returns.
 *
 * `fallback` is the default that shipped, so a caller stating no budget sees
 * what it saw before. `ceiling` is what this source will page in a single call.
 * A caller with room asks for `full` and gets the ceiling; a caller without
 * asks for `small` and stops paying for entries it has no space to read.
 */
const HISTORY_BOUNDS: BudgetBounds = { fallback: 25, ceiling: 50 };

/**
 * How many denoms an unfiltered bank scan will return.
 *
 * This list had no cap at all until response shaping went in, and that was the
 * Solana dust bug sitting unfixed on another family. The bank module enumerates
 * every denom an account holds, IBC vouchers included, and an active Osmosis
 * address holds hundreds — each one costing a denom-metadata read and a row in
 * the response. Nothing bounded that, so the ceiling was whatever the account
 * happened to hold.
 *
 * Capping it changes answers for accounts above the fallback: what came back
 * claiming `exhaustive` now comes back `truncated`, with counts. That is the
 * point. The list was never exhaustive in any sense a caller could rely on —
 * it was unbounded, which is a different thing, and it read as the first.
 */
const TOKEN_SCAN_BOUNDS: BudgetBounds = { fallback: 50, ceiling: 200 };

/**
 * Order two base-unit amounts, largest first.
 *
 * `BigInt` rather than `Number`, because a bank balance is an arbitrary-length
 * decimal string and the denoms most likely to need cutting are exactly the
 * ones with eighteen decimals and a balance past 2^53. Sorting those through a
 * float collapses distinct amounts onto the same value and makes the cut
 * arbitrary — which would be a silently unstable answer, the thing this whole
 * file is careful about.
 */
function compareAmounts(a: string, b: string): number {
  const left = toBigInt(a);
  const right = toBigInt(b);
  return left === right ? 0 : left > right ? 1 : -1;
}

function toBigInt(value: string): bigint {
  try {
    return BigInt(value);
  } catch {
    // A denom whose amount is not an integer string is malformed rather than
    // large, and sorts last rather than throwing the whole scan away.
    return -1n;
  }
}

/** What a scan covers when the caller named the denoms it wanted. */
function filteredNote(at: string): string {
  return `Every balance the account holds${at} in the denom(s) you named. Cosmos bank balances enumerate fully, so a denom absent here is genuinely not held.`;
}

/** What a scan covers when it returned everything the account holds. */
function fullNote(at: string): string {
  return `Complete: the Cosmos bank module returns every denom the account holds${at}. IBC denoms show as their hash. Decimals come from the chain's own denom metadata; where it publishes none, the amount is shown in base units and marked, rather than scaled by a guess.`;
}

/** Gas the Cosmos SDK typically needs for a single MsgSend. */
const MSG_SEND_GAS = 200_000n;
/** Fallback gas price when the chain does not advertise one, in base denom. */
const DEFAULT_GAS_PRICE = 0.025;

interface Coin {
  denom: string;
  amount: string;
}

interface BalancesResponse {
  balances: Coin[];
}

interface AccountResponse {
  account: {
    '@type'?: string;
    address?: string;
    account_number?: string;
    sequence?: string;
    // Vesting and module accounts nest the real account one level down.
    base_account?: { address: string; account_number: string; sequence: string };
  };
}

interface BlockResponse {
  block_id: { hash: string };
  block: {
    header: { height: string; time: string; chain_id: string; proposer_address: string };
    data: { txs: string[] | null };
    last_commit?: { block_id?: { hash?: string } };
  };
}

interface TxResponse {
  tx_response: {
    height: string;
    txhash: string;
    code: number;
    raw_log: string;
    gas_wanted: string;
    gas_used: string;
    timestamp: string;
  };
  tx: {
    body: { messages: Array<Record<string, unknown>>; memo: string };
    auth_info: { fee: { amount: Coin[]; gas_limit: string } };
  };
}

interface TxSearchEntry {
  txhash: string;
  height: string;
  code: number;
  timestamp?: string;
  tx?: { body?: { messages?: Array<Record<string, unknown>> } };
}

interface TxSearchResponse {
  tx_responses?: TxSearchEntry[];
  total?: string;
}

/** Message type URLs that are worth naming in a one-line summary. */
const MESSAGE_NAMES: Record<string, string> = {
  MsgSend: 'Transfer',
  MsgMultiSend: 'Multi-send',
  MsgDelegate: 'Delegation',
  MsgUndelegate: 'Undelegation',
  MsgBeginRedelegate: 'Redelegation',
  MsgWithdrawDelegatorReward: 'Reward withdrawal',
  MsgVote: 'Governance vote',
  MsgTransfer: 'IBC transfer',
  MsgExecuteContract: 'Contract call',
};

/**
 * A one-line summary in this tool's own voice.
 *
 * The message *type* is structural — a protobuf type URL the chain defines —
 * so naming it is safe. The memo is not, and is deliberately absent: it is the
 * one field a sender writes freely, and splicing it into a summary would put a
 * stranger's sentence in this tool's voice. `transaction` returns it properly,
 * marked as untrusted.
 */
function describeMessages(tx: TxSearchEntry, direction: 'in' | 'out' | 'self' | 'unknown'): string {
  const messages = tx.tx?.body?.messages ?? [];
  const first = String(messages[0]?.['@type'] ?? '').split('.').pop() ?? '';
  const name = MESSAGE_NAMES[first] ?? (first ? 'Transaction' : 'Transaction');
  const more = messages.length > 1 ? ` and ${messages.length - 1} more message(s)` : '';
  const way =
    direction === 'out' ? ' sent' : direction === 'in' ? ' received' : direction === 'self' ? ' to itself' : '';
  const failed = tx.code === 0 ? '' : ' (failed)';

  return `${name}${way}${more}${failed}.`;
}

function requireAddress(chain: ChainSpec, address: string): string {
  const decoded = bech32ToBytes(address);
  const prefix = chain.bech32Prefix ?? '';

  if (!decoded) {
    throw new InvalidAddressError(
      address,
      chain.name,
      `Expected a bech32 address starting with "${prefix}1".`,
    );
  }
  if (prefix && decoded.hrp !== prefix) {
    // Same key, different encoding — so hand back the usable address rather
    // than only explaining why this one is wrong.
    const converted = bytesToBech32(prefix, decoded.bytes);
    throw new InvalidAddressError(
      address,
      chain.name,
      `This is a "${decoded.hrp}" address but ${chain.name} uses the "${prefix}" prefix. It is the same account re-encoded: use ${converted}`,
    );
  }
  if (decoded.bytes.length !== 20 && decoded.bytes.length !== 32) {
    throw new InvalidAddressError(address, chain.name, 'Expected a 20- or 32-byte account address.');
  }
  return address;
}

/**
 * Fetch an account's coins, optionally as of a past height.
 *
 * The Cosmos SDK takes the height as a request header and echoes back the
 * height it served. That echo is the whole point: an LCD behind a proxy that
 * drops the header answers happily with *current* state, which would be
 * reported as history and be silently wrong. So the echo is required to match,
 * and anything else is an error rather than a best-effort answer.
 */
async function bankBalances(
  chain: ChainSpec,
  owner: string,
  atBlock?: number,
): Promise<Coin[]> {
  const path = `/cosmos/bank/v1beta1/balances/${owner}`;

  if (atBlock === undefined) {
    const response = await fetchWithFailover<BalancesResponse>(chain, path);
    return response?.balances ?? [];
  }

  let result;
  try {
    result = await fetchWithFailoverDetail<BalancesResponse>(chain, path, {
      headers: { 'x-cosmos-block-height': String(atBlock) },
    });
  } catch (err) {
    // Every endpoint refusing the height is the expected shape of "none of
    // these are archive nodes" — name that rather than the transport.
    if (err instanceof RpcError) {
      throw new HistoricalStateUnavailableError(chain.id, atBlock, err.message);
    }
    throw err;
  }

  const served =
    result.headers.get('grpc-metadata-x-cosmos-block-height') ??
    result.headers.get('x-cosmos-block-height');

  if (!served) {
    throw new HistoricalStateUnavailableError(
      chain.id,
      atBlock,
      'The endpoint answered without reporting which height it served, so the response cannot be distinguished from current state.',
    );
  }
  if (Number(served) !== atBlock) {
    throw new HistoricalStateUnavailableError(
      chain.id,
      atBlock,
      `The endpoint served height ${served} instead, which is current state rather than history.`,
    );
  }

  return result.data?.balances ?? [];
}

/**
 * Decimals the chain states for a denom, or nothing.
 *
 * The bank module publishes `denom_units` per denom, and where it does, that is
 * an answer rather than an inference. Where it does not — Stride declares
 * nothing for `stinj`, Kava publishes no metadata at all — there is no answer,
 * and this returns undefined instead of inventing one.
 *
 * It used to return 6 for everything that was not the gas asset, on the
 * reasoning that `u` means micro. That is true of most denoms and catastrophic
 * for the rest: `stinj` and `staevmos` track INJ and EVMOS at 18, so a Stride
 * account holding 0.16 stEVMOS was reported as holding 159,974,492,619 of it.
 * The account held six microSTRD. Nothing about the output suggested a problem.
 *
 * Negative results are cached too. A denom the chain has never heard of will
 * not start being heard of because it was asked about twice.
 */
const decimalCache = new Map<string, number | undefined>();

interface DenomMetadata {
  metadata?: { display?: string; denom_units?: { denom: string; exponent: number }[] };
}

async function statedDecimals(chain: ChainSpec, denom: string): Promise<number | undefined> {
  const key = `${chain.id}:${denom}`;
  if (decimalCache.has(key)) return decimalCache.get(key);

  let decimals: number | undefined;
  try {
    const meta = await fetchWithFailover<DenomMetadata>(
      chain,
      `/cosmos/bank/v1beta1/denoms_metadata/${encodeURIComponent(denom)}`,
      { nullOn404: true },
    );

    // The display unit is the one a human means by the name; its exponent is
    // the decimals. A metadata entry without one states nothing useful.
    const display = meta?.metadata?.display;
    const unit = meta?.metadata?.denom_units?.find((candidate) => candidate.denom === display);
    if (unit && Number.isInteger(unit.exponent)) decimals = unit.exponent;
  } catch {
    // An endpoint that will not answer is not a chain that declared 6.
    decimals = undefined;
  }

  decimalCache.set(key, decimals);
  return decimals;
}

/** Test seam: the cache is process-wide and would otherwise leak between cases. */
export function resetDenomCache(): void {
  decimalCache.clear();
}

async function denomInfo(
  chain: ChainSpec,
  denom: string,
): Promise<{ symbol: string; decimals?: number }> {
  if (denom === chain.denom) {
    return { symbol: chain.nativeCurrency.symbol, decimals: chain.nativeCurrency.decimals };
  }

  const decimals = await statedDecimals(chain, denom);

  if (denom.startsWith('ibc/')) {
    // Resolving an IBC hash to its origin needs a denom-trace lookup per token;
    // showing the hash beats guessing wrong about which asset it is. The origin
    // chain is also where its decimals live, which is why they are so often
    // absent here — and absent is what gets reported.
    return { symbol: `IBC/${denom.slice(4, 12)}…`, ...(decimals !== undefined ? { decimals } : {}) };
  }

  const stripped = denom.startsWith('u') ? denom.slice(1).toUpperCase() : denom.toUpperCase();
  return { symbol: stripped, ...(decimals !== undefined ? { decimals } : {}) };
}

export const cosmosAdapter: ChainAdapter = {
  family: 'cosmos',

  isValidAddress(chain, address) {
    const decoded = bech32ToBytes(address);
    if (!decoded) return false;
    if (chain.bech32Prefix && decoded.hrp !== chain.bech32Prefix) return false;
    return decoded.bytes.length === 20 || decoded.bytes.length === 32;
  },

  addressExpectation(chain, address) {
    const prefix = chain.bech32Prefix ?? 'cosmos';
    const decoded = address ? bech32ToBytes(address) : null;

    if (decoded && decoded.hrp !== prefix) {
      return `That is a "${decoded.hrp}" address. It is the same account on ${chain.name}, re-encoded: ${bytesToBech32(prefix, decoded.bytes)}`;
    }
    return `Expected a bech32 address starting with "${prefix}1".`;
  },

  async getNativeBalance(chain, address, options) {
    const owner = requireAddress(chain, address);
    const balances = await bankBalances(chain, owner, options?.atBlock);

    const native = balances.find((b) => b.denom === chain.denom);

    return {
      chain: chain.id,
      address: owner,
      token: { ...chain.nativeCurrency, native: true },
      // An account with no coins is a valid account holding zero, not an error.
      amount: nativeAmount(native?.amount ?? '0', chain),
      atBlock: options?.atBlock,
    };
  },

  async getTokenBalances(chain, address, tokens, options) {
    const owner = requireAddress(chain, address);
    const balances = await bankBalances(chain, owner, options?.atBlock);
    const at = options?.atBlock === undefined ? '' : ` at height ${options.atBlock}`;

    const filter = tokens?.length ? new Set(tokens.map((t) => t.toLowerCase())) : null;
    const entries: BalanceEntry[] = [];

    const held = balances.filter(
      // The native denom is reported by getNativeBalance, and a zero balance is
      // an account that was closed rather than a holding.
      (coin) => coin.denom !== chain.denom && coin.amount !== '0',
    );

    // A named filter matches on symbol as well as denom, and the symbol only
    // exists after the metadata read — so a filtered scan cannot be cut early
    // and does not need to be: it is bounded by what the caller asked for.
    // An unfiltered one is bounded by nothing, so it is ordered and cut here,
    // before the per-denom reads, where cutting actually saves the work.
    const shaped = filter
      ? { entries: held, completeness: completeness.exhaustive(filteredNote(at)) }
      : applyBudget(
          [...held].sort((a, b) => compareAmounts(b.amount, a.amount)),
          itemBudget(options?.budget, TOKEN_SCAN_BOUNDS),
          completeness.exhaustive(fullNote(at)),
          (shown, omitted) =>
            `${budgetNote(shown, omitted, 'denoms held')} Ordered by raw balance, which is ` +
            'magnitude and not value — there is no pricing here, so a trillion units of an IBC ' +
            'voucher outranks a hundred USDC. Pass `tokens` with denoms to check specific holdings.',
        );

    for (const coin of shaped.entries) {
      const info = await denomInfo(chain, coin.denom);
      if (filter && !filter.has(coin.denom.toLowerCase()) && !filter.has(info.symbol.toLowerCase())) {
        continue;
      }

      // A denom is a string anyone can mint under — tokenfactory lets whoever
      // creates it choose the text, and the symbol here is derived from it.
      const symbol = sanitizeOnchainText(info.symbol, 'token');

      // A tokenfactory denom can be minted to read as the chain's own gas
      // asset — "OSMO" on Osmosis is a denom anyone may create, and it is not
      // the OSMO the fee market runs on.
      const impersonation = checkImpersonation(chain, { symbol, address: coin.denom });

      entries.push({
        chain: chain.id,
        address: owner,
        token: {
          address: coin.denom,
          symbol,
          ...(info.decimals !== undefined ? { decimals: info.decimals } : {}),
          native: false,
          untrusted: true as const,
          ...(impersonation ? { impersonation } : {}),
        },
        amount:
          info.decimals === undefined
            ? baseUnits(coin.amount, symbol)
            : amount(coin.amount, info.decimals, symbol),
        atBlock: options?.atBlock,
      });
    }

    return { entries, completeness: shaped.completeness };
  },

  /**
   * What an address has been doing, from the chain's own tx index.
   *
   * No indexer and no key: the LCD indexes transactions by event, so this is
   * two searches — one for transactions the address sent, one for transfers it
   * received — merged and sorted. Both are needed because they are different
   * events, and a history of only what you sent is not a history.
   *
   * The honest limit is which events those two queries catch. An address
   * touched by a contract call, a governance message or an IBC relay it did not
   * itself sign may not appear, so this is not "everything mentioning the
   * address" and the note does not claim to be. A transaction found by both
   * queries is a transfer to yourself and is reported as one.
   */
  async getHistory(chain, address, options) {
    const owner = requireAddress(chain, address);
    const limit = itemBudget(options?.budget, HISTORY_BOUNDS, options?.limit);
    const offset = Number(options?.cursor ?? 0) || 0;

    const search = async (query: string): Promise<TxSearchResponse | null> => {
      const params = new URLSearchParams({
        query,
        order_by: 'ORDER_BY_DESC',
        'pagination.limit': String(limit),
        'pagination.offset': String(offset),
      });
      try {
        return await fetchWithFailover<TxSearchResponse>(
          chain,
          `/cosmos/tx/v1beta1/txs?${params.toString()}`,
          { nullOn404: true },
        );
      } catch {
        // One of the two searches failing should not erase the other; the
        // completeness note carries the shortfall instead.
        return null;
      }
    };

    const [sent, received] = await Promise.all([
      search(`message.sender='${owner}'`),
      search(`transfer.recipient='${owner}'`),
    ]);

    if (!sent && !received) {
      return {
        chain: chain.id,
        address: owner,
        entries: [],
        completeness: completeness.failed(
          `${chain.name} did not answer a transaction search, so nothing is known about this address's history. This is an endpoint failure, not an empty history — do not read it as "no activity".`,
        ),
      };
    }

    const direction = new Map<string, 'in' | 'out' | 'self'>();
    const byHash = new Map<string, TxSearchEntry>();

    for (const [response, way] of [
      [sent, 'out'],
      [received, 'in'],
    ] as const) {
      for (const tx of response?.tx_responses ?? []) {
        byHash.set(tx.txhash, tx);
        // Present in both searches means the address paid itself.
        direction.set(tx.txhash, direction.has(tx.txhash) ? 'self' : way);
      }
    }

    const ordered = [...byHash.values()]
      .sort((a, b) => Number(b.height) - Number(a.height))
      .slice(0, limit);

    const entries: HistoryEntry[] = ordered.map((tx) => ({
      hash: tx.txhash,
      status: tx.code === 0 ? ('success' as const) : ('failed' as const),
      direction: direction.get(tx.txhash) ?? 'unknown',
      blockNumber: Number(tx.height),
      ...(tx.timestamp ? { timestamp: tx.timestamp } : {}),
      summary: describeMessages(tx, direction.get(tx.txhash) ?? 'unknown'),
      ...(explorerUrl(chain, 'tx', tx.txhash)
        ? { explorerUrl: explorerUrl(chain, 'tx', tx.txhash) as string }
        : {}),
    }));

    const matched = Number(sent?.total ?? 0) + Number(received?.total ?? 0);
    const partial = !sent || !received;
    const caveat = partial
      ? ` One of the two searches failed, so this covers only what the address ${sent ? 'sent' : 'received'}.`
      : '';
    const scope =
      ' Found by two event searches — transactions this address sent, and transfers it received — so a transaction that merely mentions the address may not appear.';

    return {
      chain: chain.id,
      address: owner,
      entries,
      completeness:
        entries.length === limit
          ? completeness.paged(entries.length, `Page of ${entries.length}.${scope}${caveat}`)
          : completeness.exhaustive(
              `Every transaction the chain's index returns for this address${entries.length ? '' : ', which is none'}, out of ${matched} matched.${scope}${caveat}`,
            ),
      ...(entries.length === limit ? { cursor: String(offset + limit) } : {}),
    };
  },

  async getTransaction(chain, hash) {
    // Cosmos tx hashes are uppercase hex, and LCDs are strict about it.
    const normalized = hash.replace(/^0x/i, '').toUpperCase();
    const response = await fetchWithFailover<TxResponse>(
      chain,
      `/cosmos/tx/v1beta1/txs/${normalized}`,
      { nullOn404: true },
    );

    if (!response?.tx_response) {
      throw new SingularityError(
        'TX_NOT_FOUND',
        `Transaction ${shortAddress(normalized, 10, 8)} was not found on ${chain.name}.`,
        'Cosmos tx hashes are uppercase hex with no 0x prefix. Public LCDs also prune old history.',
      );
    }

    const { tx_response: receipt, tx } = response;
    const feeCoin = tx.auth_info.fee.amount[0];
    const messages = tx.body.messages;
    const types = messages.map((m) => String(m['@type'] ?? 'unknown').split('.').pop());
    const failed = receipt.code !== 0;

    // Sum the value across any bank sends in the transaction.
    let sendTotal = 0n;
    let sender: string | undefined;
    let recipient: string | undefined;
    for (const message of messages) {
      if (String(message['@type'] ?? '').endsWith('MsgSend')) {
        sender ??= message.from_address as string;
        recipient ??= message.to_address as string;
        for (const coin of (message.amount as Coin[]) ?? []) {
          if (coin.denom === chain.denom) sendTotal += BigInt(coin.amount);
        }
      }
    }

    const memo = untrustedText(
      tx.body.memo,
      "the transaction's memo, free text chosen by whoever sent it",
    );
    const failureLog = failed
      ? untrustedText(
          receipt.raw_log,
          "the chain's error log for this transaction; a contract chooses its own revert text",
        )
      : undefined;

    return {
      chain: chain.id,
      hash: receipt.txhash,
      status: failed ? 'failed' : 'success',
      blockNumber: Number(receipt.height),
      timestamp: receipt.timestamp,
      from: sender,
      to: recipient,
      value: nativeAmount(sendTotal, chain),
      fee: feeCoin ? nativeAmount(feeCoin.amount, chain) : nativeAmount('0', chain),
      // Neither line below quotes the chain. The memo and the failure log used
      // to be interpolated here, which put a sentence the sender wrote inside a
      // sentence the tool wrote, with no seam between them. Both now travel as
      // marked values, and `summary` says where to find them rather than saying
      // what they contain.
      summary: failed
        ? `Failed transaction on ${chain.name} (code ${receipt.code}). The chain's own explanation is in \`failureLog\`, written by the contract that reverted.`
        : `${messages.length} message(s) [${types.join(', ')}] on ${chain.name}, ${receipt.gas_used}/${receipt.gas_wanted} gas used.`,
      decoded: {
        // Message *types* are protobuf type URLs from the chain's own schema —
        // a sender picks which one, never what it is called — so these are safe
        // to name in prose. The message bodies are not.
        note: `Message types: ${types.join(', ')}`,
        // Every body, unconditionally. There is no subset of message types
        // that is safe by construction: `MsgExecuteContract` carries JSON the
        // sender wrote outright, and even a bank send carries a `denom`, which
        // on a chain with tokenfactory is a string somebody minted and chose
        // the wording of. A whitelist here would be a guess about schemas this
        // tool does not model, which is the kind of guess that ships quiet.
        args: messages.slice(0, 5).map((m) => ({
          type: String(m['@type'] ?? 'unknown'),
          value: JSON.stringify(sanitizeOnchainDeep(m)).slice(0, 300),
          untrusted: true as const,
        })),
      },
      ...(memo ? { memo } : {}),
      ...(failureLog ? { failureLog } : {}),
      explorerUrl: explorerUrl(chain, 'tx', receipt.txhash),
      raw: {
        gasUsed: receipt.gas_used,
        gasWanted: receipt.gas_wanted,
        code: receipt.code,
        // The memo is deliberately *not* repeated here. An unmarked second copy
        // of a marked value is the mark being bypassed, and `raw` is the field
        // most likely to be splatted into a prompt wholesale.
      },
    } satisfies NormalizedTx;
  },

  /**
   * Every committed block, which is every block there is.
   *
   * Tendermint finalizes on commit: more than two thirds of voting power has
   * already signed the block before it exists, and undoing one means that
   * majority publishing evidence of its own double-signing and being slashed
   * for it. So the finalized height is the tip, and this is the only family
   * here where that answer is honest rather than the aliasing bug the EVM
   * adapter guards against.
   */
  async finalizedHeight(chain) {
    const response = await fetchWithFailover<BlockResponse>(
      chain,
      '/cosmos/base/tendermint/v1beta1/blocks/latest',
      { nullOn404: true },
    );

    const height = Number(response?.block?.header?.height);
    return Number.isFinite(height) ? height : null;
  },

  async getBlock(chain, ref) {
    const path =
      ref === 'latest' || ref === ''
        ? '/cosmos/base/tendermint/v1beta1/blocks/latest'
        : `/cosmos/base/tendermint/v1beta1/blocks/${ref}`;

    const response = await fetchWithFailover<BlockResponse>(chain, path, { nullOn404: true });
    if (!response?.block) {
      throw new SingularityError('BLOCK_NOT_FOUND', `Block ${ref} was not found on ${chain.name}.`);
    }

    const { block, block_id } = response;

    return {
      chain: chain.id,
      number: Number(block.header.height),
      hash: block_id.hash,
      timestamp: block.header.time,
      txCount: block.data.txs?.length ?? 0,
      parentHash: block.last_commit?.block_id?.hash,
      explorerUrl: explorerUrl(chain, 'block', block.header.height),
      raw: { chainId: block.header.chain_id, proposer: block.header.proposer_address },
    } satisfies NormalizedBlock;
  },

  async estimateFees(chain) {
    const gasPrice = DEFAULT_GAS_PRICE;
    const feeRaw = BigInt(Math.ceil(gasPrice * Number(MSG_SEND_GAS)));

    return {
      chain: chain.id,
      simpleTransfer: nativeAmount(feeRaw, chain),
      details: {
        gasPrice: `${gasPrice} ${chain.denom}`,
        gasForMsgSend: MSG_SEND_GAS.toString(),
        denom: chain.denom ?? 'unknown',
      },
      note: 'Cosmos gas prices are set per-validator, not by the chain. This uses a common default; your wallet may quote differently.',
    } satisfies FeeEstimate;
  },

  async buildTransfer(chain, params) {
    if (!params.from) {
      throw new SingularityError(
        'MISSING_FROM',
        'A Cosmos transfer needs a `from` address.',
        'The account number and sequence must be fetched for the sender before a signable document can be built.',
      );
    }

    const from = requireAddress(chain, params.from);
    const to = requireAddress(chain, params.to);
    const denom = params.token ?? chain.denom;

    if (!denom) {
      throw new SingularityError('MISSING_DENOM', `No base denom is configured for ${chain.name}.`);
    }

    const info = params.token
      ? await denomInfo(chain, params.token)
      : { symbol: chain.nativeCurrency.symbol, decimals: chain.nativeCurrency.decimals };

    // A display amount cannot be turned into base units without knowing the
    // scale, and being wrong here is not a rendering problem — it is a transfer
    // of a millionth or a trillionth of what was meant. Refusing beats guessing.
    if (info.decimals === undefined) {
      throw new SingularityError(
        'DENOM_DECIMALS_UNKNOWN',
        `${chain.name} does not declare how many decimals ${denom} has, so "${params.amount}" cannot be converted to base units.`,
        'Pass the amount in base units as the denom itself, or transfer a denom whose metadata the chain publishes.',
      );
    }

    const value = parseUnits(params.amount, info.decimals);

    const account = await fetchWithFailover<AccountResponse>(
      chain,
      `/cosmos/auth/v1beta1/accounts/${from}`,
      { nullOn404: true },
    );

    const base = account?.account.base_account ?? account?.account;
    if (!base?.account_number) {
      throw new SingularityError(
        'ACCOUNT_NOT_FOUND',
        `${shortAddress(from)} has never been seen on ${chain.name}.`,
        'An account only exists on-chain once it has received funds. It cannot send before then.',
      );
    }

    const feeRaw = BigInt(Math.ceil(DEFAULT_GAS_PRICE * Number(MSG_SEND_GAS)));

    return {
      chain: chain.id,
      family: 'cosmos',
      summary: `Send ${params.amount} ${info.symbol} from ${shortAddress(from)} to ${shortAddress(to)} on ${chain.name}.`,
      payload: {
        chainId: chain.chainId,
        accountNumber: base.account_number,
        sequence: base.sequence ?? '0',
        memo: params.memo ?? '',
        fee: {
          amount: [{ denom: chain.denom, amount: feeRaw.toString() }],
          gas: MSG_SEND_GAS.toString(),
        },
        msgs: [
          {
            '@type': '/cosmos.bank.v1beta1.MsgSend',
            from_address: from,
            to_address: to,
            amount: [{ denom, amount: value.toString() }],
          },
        ],
      },
      signingHint:
        'This is a SignDoc body. Feed it to Keplr/Leap via signDirect or signAmino, or to CosmJS SigningStargateClient. Singularity holds no keys.',
      warnings: [
        'This transaction is unsigned. Review every field before signing.',
        'The fee uses a common default gas price; validators may require more. Your wallet will usually re-quote it.',
        ...(chain.testnet ? [`${chain.name} is a test network — these tokens have no value.`] : []),
      ],
    } satisfies UnsignedTx;
  },

  async readContract(chain) {
    throw new UnsupportedOperationError(
      'contract reads',
      `${chain.name} (Cosmos)`,
      'CosmWasm smart-contract queries are not wired up. Query the chain module REST endpoints directly for now.',
    );
  },
};
