import type { ChainAdapter } from '../core/adapter.js';
import type {
  BalanceEntry,
  ChainSpec,
  FeeEstimate,
  NormalizedBlock,
  NormalizedTx,
  UnsignedTx,
} from '../core/types.js';
import { completeness, sanitizeOnchainText } from '../core/envelope.js';
import {
  HistoricalStateUnavailableError,
  InvalidAddressError,
  RpcError,
  SingularityError,
  UnsupportedOperationError,
} from '../core/errors.js';
import { amount, explorerUrl, nativeAmount, parseUnits, shortAddress } from '../core/format.js';
import { fetchWithFailover, fetchWithFailoverDetail } from '../core/http.js';
import { bech32ToBytes, bytesToBech32 } from '../core/address-codec.js';

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

function denomInfo(chain: ChainSpec, denom: string): { symbol: string; decimals: number } {
  if (denom === chain.denom) {
    return { symbol: chain.nativeCurrency.symbol, decimals: chain.nativeCurrency.decimals };
  }
  if (denom.startsWith('ibc/')) {
    // Resolving an IBC hash to its origin needs a denom-trace lookup per token;
    // showing the hash beats guessing wrong about which asset it is.
    return { symbol: `IBC/${denom.slice(4, 12)}…`, decimals: 6 };
  }
  // Most Cosmos denoms are micro-units of a 6-decimal asset.
  const stripped = denom.startsWith('u') ? denom.slice(1).toUpperCase() : denom.toUpperCase();
  return { symbol: stripped, decimals: 6 };
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

    const filter = tokens?.length ? new Set(tokens.map((t) => t.toLowerCase())) : null;
    const entries: BalanceEntry[] = [];

    for (const coin of balances) {
      if (coin.denom === chain.denom) continue; // reported by getNativeBalance
      if (coin.amount === '0') continue;

      const info = denomInfo(chain, coin.denom);
      if (filter && !filter.has(coin.denom.toLowerCase()) && !filter.has(info.symbol.toLowerCase())) {
        continue;
      }

      // A denom is a string anyone can mint under — tokenfactory lets whoever
      // creates it choose the text, and the symbol here is derived from it.
      const symbol = sanitizeOnchainText(info.symbol, 'token');

      entries.push({
        chain: chain.id,
        address: owner,
        token: {
          address: coin.denom,
          symbol,
          decimals: info.decimals,
          native: false,
          untrusted: true as const,
        },
        amount: amount(coin.amount, info.decimals, symbol),
        atBlock: options?.atBlock,
      });
    }

    const at = options?.atBlock === undefined ? '' : ` at height ${options.atBlock}`;

    return {
      entries,
      completeness: completeness.exhaustive(
        tokens?.length
          ? `Every balance the account holds${at} in the denom(s) you named. Cosmos bank balances enumerate fully, so a denom absent here is genuinely not held.`
          : `Complete: the Cosmos bank module returns every denom the account holds${at}. IBC denoms show as their hash, and decimals for non-native denoms are assumed to be 6.`,
      ),
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
      summary: failed
        ? `Failed transaction on ${chain.name} (code ${receipt.code}): ${receipt.raw_log.slice(0, 200)}`
        : `${messages.length} message(s) [${types.join(', ')}] on ${chain.name}, ${receipt.gas_used}/${receipt.gas_wanted} gas used.`,
      decoded: {
        note: `Message types: ${types.join(', ')}${tx.body.memo ? `. Memo: "${tx.body.memo}"` : ''}`,
        args: messages.slice(0, 5).map((m) => ({
          type: String(m['@type'] ?? 'unknown'),
          value: JSON.stringify(m).slice(0, 300),
        })),
      },
      explorerUrl: explorerUrl(chain, 'tx', receipt.txhash),
      raw: {
        gasUsed: receipt.gas_used,
        gasWanted: receipt.gas_wanted,
        code: receipt.code,
        memo: tx.body.memo,
      },
    } satisfies NormalizedTx;
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

    const info = params.token ? denomInfo(chain, params.token) : {
      symbol: chain.nativeCurrency.symbol,
      decimals: chain.nativeCurrency.decimals,
    };
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
