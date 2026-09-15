import type { ChainFamily } from './types.js';
import { allChains } from './registry.js';
import { bech32ToBytes, decodeBase58Check, decodeBech32 } from './address-codec.js';

export type InputKind = 'address' | 'tx' | 'name' | 'block' | 'unknown';

export interface Detection {
  kind: InputKind;
  /** Families this input could belong to, most likely first. */
  families: ChainFamily[];
  /** Chains it could belong to, narrowed where the format pins it down. */
  chains: string[];
  reason: string;
}

const HEX_40 = /^0x[0-9a-fA-F]{40}$/;
const HEX_64 = /^(0x)?[0-9a-fA-F]{64}$/;
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const ENS_NAME = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.(eth|xyz|com|org|io|art|box|crypto|nft|dao)$/i;
const SNS_NAME = /^[a-z0-9-]+\.sol$/i;

/**
 * Work out what a bare string is without asking the user.
 *
 * This is the difference between "which chain?" prompts and just answering the
 * question. Ambiguity is reported honestly — an 0x…64 hex string is a tx hash
 * on every EVM chain at once, and we say so rather than picking one.
 */
export function detect(input: string): Detection {
  const value = input.trim();
  const chains = allChains();

  if (HEX_40.test(value)) {
    return {
      kind: 'address',
      families: ['evm'],
      chains: chains.filter((c) => c.family === 'evm').map((c) => c.id),
      reason: '0x followed by 40 hex characters is an EVM account or contract address.',
    };
  }

  if (SNS_NAME.test(value)) {
    return {
      kind: 'name',
      families: ['svm'],
      chains: ['solana'],
      reason: 'A .sol name resolves through the Solana Name Service.',
    };
  }

  if (ENS_NAME.test(value)) {
    return {
      kind: 'name',
      families: ['evm'],
      chains: ['ethereum'],
      reason: 'Resolves through ENS on Ethereum mainnet; the resulting address works on every EVM chain.',
    };
  }

  // Cosmos addresses announce their chain in the prefix, which makes them the
  // one address format that is never ambiguous.
  const bech = bech32ToBytes(value);
  if (bech && !decodeBech32(value)) {
    const matches = chains.filter((c) => c.family === 'cosmos' && c.bech32Prefix === bech.hrp);
    if (matches.length) {
      return {
        kind: 'address',
        families: ['cosmos'],
        chains: matches.map((c) => c.id),
        reason: `The "${bech.hrp}" bech32 prefix identifies ${matches.map((c) => c.name).join(', ')}.`,
      };
    }
  }

  // SegWit addresses also carry their network in the hrp.
  const segwit = decodeBech32(value);
  if (segwit) {
    const matches = chains.filter(
      (c) => c.family === 'utxo' && NETWORK_HRP[c.id] === segwit.hrp,
    );
    return {
      kind: 'address',
      families: ['utxo'],
      chains: matches.length ? matches.map((c) => c.id) : ['bitcoin'],
      reason: `A bech32 "${segwit.hrp}1…" address is native SegWit (v${segwit.version}).`,
    };
  }

  if (HEX_64.test(value)) {
    const evmChains = chains.filter((c) => c.family === 'evm').map((c) => c.id);
    const cosmosChains = chains.filter((c) => c.family === 'cosmos').map((c) => c.id);
    const prefixed = value.startsWith('0x');
    return {
      kind: 'tx',
      families: prefixed ? ['evm'] : ['evm', 'utxo', 'cosmos'],
      chains: prefixed ? evmChains : [...evmChains, 'bitcoin', ...cosmosChains],
      reason: prefixed
        ? '0x + 64 hex characters is an EVM transaction hash. Which EVM chain it is on cannot be told from the hash alone.'
        : '64 hex characters with no prefix could be an EVM tx hash, a Bitcoin txid, or a Cosmos tx hash.',
    };
  }

  // Base58 covers both Solana addresses (32 bytes) and Bitcoin legacy addresses,
  // which are distinguished by their checksum rather than their shape.
  if (BASE58.test(value)) {
    if (decodeBase58Check(value)) {
      return {
        kind: 'address',
        families: ['utxo'],
        chains: ['bitcoin', 'litecoin'],
        reason: 'A base58 string with a valid 4-byte checksum is a legacy UTXO address.',
      };
    }
    return {
      kind: 'address',
      families: ['svm'],
      chains: chains.filter((c) => c.family === 'svm').map((c) => c.id),
      reason: 'A 32-44 character base58 string with no base58check checksum is a Solana public key.',
    };
  }

  // Solana signatures are base58 but longer than an address.
  if (/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(value)) {
    return {
      kind: 'tx',
      families: ['svm'],
      chains: chains.filter((c) => c.family === 'svm').map((c) => c.id),
      reason: 'A base58 string of 64-90 characters is a Solana transaction signature.',
    };
  }

  if (/^\d+$/.test(value)) {
    return {
      kind: 'block',
      families: ['evm', 'svm', 'utxo', 'cosmos'],
      chains: [],
      reason: 'A bare number is a block height or slot — it needs a chain to mean anything.',
    };
  }

  return {
    kind: 'unknown',
    families: [],
    chains: [],
    reason: 'Not a recognized address, transaction hash, name, or block height.',
  };
}

/** hrp per UTXO chain, mirroring NETWORKS in address-codec. */
const NETWORK_HRP: Record<string, string> = {
  bitcoin: 'bc',
  'bitcoin-testnet': 'tb',
  litecoin: 'ltc',
};
