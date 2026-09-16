import type { ChainAdapter } from '../core/adapter.js';
import type {
  ChainSpec,
  FeeEstimate,
  NormalizedBlock,
  NormalizedTx,
  UnsignedTx,
} from '../core/types.js';
import {
  HistoricalStateUnsupportedError,
  InvalidAddressError,
  SingularityError,
  UnsupportedOperationError,
} from '../core/errors.js';
import { explorerUrl, nativeAmount, parseUnits, shortAddress, toIso } from '../core/format.js';
import { fetchWithFailover } from '../core/http.js';
import {
  NETWORKS,
  addressToScriptPubKey,
  varInt,
  type NetworkParams,
} from '../core/address-codec.js';

/** Rough vbyte costs used for fee estimation and coin selection. */
const VBYTES_PER_INPUT = 68; // P2WPKH input, the common case
const VBYTES_PER_OUTPUT = 31;
const VBYTES_OVERHEAD = 11;
/** Below this, a change output costs more to spend than it is worth. */
const DUST_THRESHOLD = 546n;

interface EsploraAddressStats {
  address: string;
  chain_stats: { funded_txo_sum: number; spent_txo_sum: number; tx_count: number };
  mempool_stats: { funded_txo_sum: number; spent_txo_sum: number; tx_count: number };
}

interface EsploraUtxo {
  txid: string;
  vout: number;
  value: number;
  status: { confirmed: boolean; block_height?: number };
}

interface EsploraTx {
  txid: string;
  version: number;
  locktime: number;
  size: number;
  weight: number;
  fee: number;
  vin: Array<{ txid: string; vout: number; prevout?: { scriptpubkey_address?: string; value: number } }>;
  vout: Array<{ scriptpubkey_address?: string; value: number }>;
  status: { confirmed: boolean; block_height?: number; block_time?: number };
}

interface EsploraBlock {
  id: string;
  height: number;
  timestamp: number;
  tx_count: number;
  previousblockhash?: string;
  size: number;
  weight: number;
}

function networkFor(chain: ChainSpec): NetworkParams {
  const network = NETWORKS[chain.id];
  if (!network) {
    throw new SingularityError(
      'UNSUPPORTED_NETWORK',
      `No UTXO address parameters are configured for "${chain.id}".`,
      'Add bech32Hrp / p2pkhVersion / p2shVersion for this chain, or use bitcoin, bitcoin-testnet, or litecoin.',
    );
  }
  return network;
}

function requireAddress(chain: ChainSpec, address: string): string {
  const network = networkFor(chain);
  if (!addressToScriptPubKey(address, network)) {
    throw new InvalidAddressError(
      address,
      chain.name,
      `Expected a ${network.bech32Hrp}1… bech32 address, or a legacy base58 address with a valid checksum for ${chain.name}.`,
    );
  }
  return address;
}

export const bitcoinAdapter: ChainAdapter = {
  family: 'utxo',

  isValidAddress(chain, address) {
    try {
      return addressToScriptPubKey(address, networkFor(chain)) !== null;
    } catch {
      return false;
    }
  },

  addressExpectation(chain) {
    const network = NETWORKS[chain.id];
    return network
      ? `Expected a ${network.bech32Hrp}1… bech32 address or a legacy base58 address.`
      : 'Expected a bech32 or base58 UTXO address.';
  },

  async getNativeBalance(chain, address, options) {
    if (options?.atBlock !== undefined) {
      // Esplora reports an address's running totals and its transaction list;
      // there is no balance-at-height query. The balance at a past height is
      // derivable by replaying that history up to the height — which is the
      // indexer work in roadmap 1.2, not something to fake here.
      throw new HistoricalStateUnsupportedError(
        chain.name,
        'Esplora exposes an address\'s current funded/spent totals, with no balance-at-height query. Deriving one means replaying the address history to that height, which needs the transaction-history work this tool has not shipped yet.',
      );
    }
    const owner = requireAddress(chain, address);
    const stats = await fetchWithFailover<EsploraAddressStats>(chain, `/address/${owner}`);

    if (!stats) {
      throw new SingularityError('ADDRESS_NOT_FOUND', `No data for ${shortAddress(owner)} on ${chain.name}.`);
    }

    // Confirmed + mempool, so a freshly received payment is not invisible.
    const confirmed = BigInt(stats.chain_stats.funded_txo_sum - stats.chain_stats.spent_txo_sum);
    const pending = BigInt(stats.mempool_stats.funded_txo_sum - stats.mempool_stats.spent_txo_sum);

    return {
      chain: chain.id,
      address: owner,
      token: { ...chain.nativeCurrency, native: true },
      amount: nativeAmount(confirmed + pending, chain),
    };
  },

  async getTokenBalances(chain) {
    throw new UnsupportedOperationError(
      'token balances',
      `${chain.name} (UTXO)`,
      'UTXO chains have no token contracts. Ordinals/Runes need a dedicated indexer, which this tool does not bundle.',
    );
  },

  async getTransaction(chain, hash) {
    const tx = await fetchWithFailover<EsploraTx>(chain, `/tx/${hash}`, { nullOn404: true });

    if (!tx) {
      throw new SingularityError(
        'TX_NOT_FOUND',
        `Transaction ${shortAddress(hash, 10, 8)} was not found on ${chain.name}.`,
        'Check the txid, or the transaction may not have propagated yet.',
      );
    }

    const totalOut = tx.vout.reduce((sum, out) => sum + BigInt(out.value), 0n);
    const inputAddresses = [
      ...new Set(tx.vin.map((v) => v.prevout?.scriptpubkey_address).filter(Boolean)),
    ] as string[];
    const outputAddresses = [
      ...new Set(tx.vout.map((v) => v.scriptpubkey_address).filter(Boolean)),
    ] as string[];

    return {
      chain: chain.id,
      hash: tx.txid,
      status: tx.status.confirmed ? 'success' : 'pending',
      blockNumber: tx.status.block_height,
      timestamp: toIso(tx.status.block_time),
      from: inputAddresses[0],
      to: outputAddresses[0],
      value: nativeAmount(totalOut, chain),
      fee: nativeAmount(BigInt(tx.fee), chain),
      summary: `${tx.vin.length} input(s) -> ${tx.vout.length} output(s), ${nativeAmount(totalOut, chain).formatted} ${chain.nativeCurrency.symbol} moved on ${chain.name}${tx.status.confirmed ? '' : ' (unconfirmed)'}.`,
      decoded: {
        note: `Inputs from: ${inputAddresses.slice(0, 3).join(', ') || 'unknown'}. Outputs to: ${outputAddresses.slice(0, 3).join(', ') || 'unknown'}.`,
      },
      explorerUrl: explorerUrl(chain, 'tx', tx.txid),
      raw: {
        size: tx.size,
        weight: tx.weight,
        vsize: Math.ceil(tx.weight / 4),
        feeRate: `${(tx.fee / Math.ceil(tx.weight / 4)).toFixed(2)} sat/vB`,
        version: tx.version,
        locktime: tx.locktime,
      },
    } satisfies NormalizedTx;
  },

  async getBlock(chain, ref) {
    let hash: string;

    if (ref === 'latest' || ref === '') {
      const tip = await fetchWithFailover<string>(chain, '/blocks/tip/hash');
      hash = String(tip).trim();
    } else if (typeof ref === 'number' || /^\d+$/.test(String(ref))) {
      const byHeight = await fetchWithFailover<string>(chain, `/block-height/${ref}`, {
        nullOn404: true,
      });
      if (!byHeight) {
        throw new SingularityError('BLOCK_NOT_FOUND', `No block at height ${ref} on ${chain.name}.`);
      }
      hash = String(byHeight).trim();
    } else {
      hash = String(ref);
    }

    const block = await fetchWithFailover<EsploraBlock>(chain, `/block/${hash}`, { nullOn404: true });
    if (!block) {
      throw new SingularityError('BLOCK_NOT_FOUND', `Block ${shortAddress(hash, 10, 8)} not found on ${chain.name}.`);
    }

    return {
      chain: chain.id,
      number: block.height,
      hash: block.id,
      timestamp: toIso(block.timestamp),
      txCount: block.tx_count,
      parentHash: block.previousblockhash,
      explorerUrl: explorerUrl(chain, 'block', block.id),
      raw: { size: block.size, weight: block.weight },
    } satisfies NormalizedBlock;
  },

  async estimateFees(chain) {
    const estimates = await fetchWithFailover<Record<string, number>>(chain, '/fee-estimates');
    if (!estimates) throw new SingularityError('NO_FEE_DATA', `${chain.name} returned no fee estimates.`);

    const fast = estimates['1'] ?? estimates['2'] ?? 0;
    const medium = estimates['6'] ?? fast;
    const slow = estimates['144'] ?? medium;

    // A 1-in / 2-out P2WPKH spend, the typical wallet payment.
    const typicalVbytes = VBYTES_OVERHEAD + VBYTES_PER_INPUT + VBYTES_PER_OUTPUT * 2;

    return {
      chain: chain.id,
      simpleTransfer: nativeAmount(BigInt(Math.ceil(medium * typicalVbytes)), chain),
      details: {
        nextBlock: `${fast.toFixed(1)} sat/vB`,
        within6Blocks: `${medium.toFixed(1)} sat/vB`,
        within24Hours: `${slow.toFixed(1)} sat/vB`,
        assumedTxSize: `${typicalVbytes} vB (1 input, 2 outputs, P2WPKH)`,
      },
      note: 'Bitcoin fees are per-vbyte, so cost depends on how many UTXOs you spend, not on the amount sent.',
    } satisfies FeeEstimate;
  },

  async buildTransfer(chain, params) {
    if (params.token) {
      throw new UnsupportedOperationError(
        'token transfers',
        `${chain.name} (UTXO)`,
        'There are no token contracts on UTXO chains.',
      );
    }
    if (!params.from) {
      throw new SingularityError(
        'MISSING_FROM',
        'A UTXO transfer needs a `from` address.',
        'Coins must be selected from a specific address before a transaction can be built.',
      );
    }

    const network = networkFor(chain);
    const from = requireAddress(chain, params.from);
    const to = requireAddress(chain, params.to);
    const target = parseUnits(params.amount, chain.nativeCurrency.decimals);

    const [utxos, estimates] = await Promise.all([
      fetchWithFailover<EsploraUtxo[]>(chain, `/address/${from}/utxo`),
      fetchWithFailover<Record<string, number>>(chain, '/fee-estimates').catch(() => null),
    ]);

    if (!utxos?.length) {
      throw new SingularityError(
        'NO_UTXOS',
        `${shortAddress(from)} has no spendable outputs on ${chain.name}.`,
      );
    }

    const feeRate = Math.max(1, Math.ceil(estimates?.['6'] ?? 5));

    // Largest-first selection: fewest inputs, so the smallest fee. Not privacy
    // optimal, but predictable — and the user reviews the plan before signing.
    const sorted = [...utxos].sort((a, b) => b.value - a.value);
    const selected: EsploraUtxo[] = [];
    let inputTotal = 0n;
    let fee = 0n;

    for (const utxo of sorted) {
      selected.push(utxo);
      inputTotal += BigInt(utxo.value);
      const vbytes = VBYTES_OVERHEAD + selected.length * VBYTES_PER_INPUT + VBYTES_PER_OUTPUT * 2;
      fee = BigInt(Math.ceil(vbytes * feeRate));
      if (inputTotal >= target + fee) break;
    }

    if (inputTotal < target + fee) {
      throw new SingularityError(
        'INSUFFICIENT_FUNDS',
        `${shortAddress(from)} holds ${nativeAmount(inputTotal, chain).formatted} ${chain.nativeCurrency.symbol} but needs ${nativeAmount(target + fee, chain).formatted} (amount + ~${nativeAmount(fee, chain).formatted} fee).`,
        'Lower the amount, or wait for a cheaper fee rate.',
      );
    }

    const change = inputTotal - target - fee;
    const warnings = ['This transaction is unsigned. Review every input and output before signing.'];

    const outputs: Array<{ address: string; value: bigint }> = [{ address: to, value: target }];

    if (change > DUST_THRESHOLD) {
      outputs.push({ address: from, value: change });
    } else if (change > 0n) {
      // Dust change is cheaper to burn as fee than to create and later spend.
      fee += change;
      warnings.push(
        `Change of ${change} sats is below the dust threshold, so it has been added to the fee instead of creating a change output.`,
      );
    }

    if (chain.testnet) warnings.push(`${chain.name} is a test network — these coins have no value.`);

    const unsignedHex = serializeUnsignedTx(selected, outputs, network);

    return {
      chain: chain.id,
      family: 'utxo',
      summary: `Spend ${selected.length} UTXO(s) from ${shortAddress(from)} to send ${params.amount} ${chain.nativeCurrency.symbol} to ${shortAddress(to)} on ${chain.name}, paying ~${nativeAmount(fee, chain).formatted} in fees.`,
      payload: {
        unsignedTxHex: unsignedHex,
        feeRate: `${feeRate} sat/vB`,
        fee: fee.toString(),
        inputs: selected.map((u) => ({
          txid: u.txid,
          vout: u.vout,
          value: u.value,
          confirmed: u.status.confirmed,
        })),
        outputs: outputs.map((o) => ({ address: o.address, value: o.value.toString() })),
        totalInput: inputTotal.toString(),
      },
      signingHint:
        'The hex is an unsigned transaction with empty scriptSigs. Import it into your wallet (or build a PSBT from these inputs/outputs) to sign. Singularity holds no keys and cannot sign or broadcast.',
      warnings,
    } satisfies UnsignedTx;
  },
};

/**
 * Serialize a pre-SegWit-format unsigned transaction (empty scriptSigs).
 *
 * Exported for testing: byte order here is unforgiving — txids are displayed
 * big-endian but serialized little-endian — and a silent mistake produces a hex
 * blob that looks plausible and spends the wrong output.
 */
export function serializeUnsignedTx(
  inputs: Array<Pick<EsploraUtxo, 'txid' | 'vout'>>,
  outputs: Array<{ address: string; value: bigint }>,
  network: NetworkParams,
): string {
  const parts: Buffer[] = [];

  const version = Buffer.alloc(4);
  version.writeUInt32LE(2, 0);
  parts.push(version, varInt(inputs.length));

  for (const input of inputs) {
    // txids are displayed big-endian but serialized little-endian.
    parts.push(Buffer.from(input.txid, 'hex').reverse());
    const vout = Buffer.alloc(4);
    vout.writeUInt32LE(input.vout, 0);
    parts.push(vout);
    parts.push(varInt(0)); // empty scriptSig — this is the unsigned form
    parts.push(Buffer.from([0xff, 0xff, 0xff, 0xfd])); // RBF-enabled sequence
  }

  parts.push(varInt(outputs.length));

  for (const output of outputs) {
    const value = Buffer.alloc(8);
    value.writeBigUInt64LE(output.value, 0);
    parts.push(value);

    const decoded = addressToScriptPubKey(output.address, network);
    if (!decoded) throw new SingularityError('BAD_OUTPUT', `Cannot encode output address ${output.address}.`);
    parts.push(varInt(decoded.scriptPubKey.length), decoded.scriptPubKey);
  }

  parts.push(Buffer.alloc(4)); // locktime 0

  return Buffer.concat(parts).toString('hex');
}
