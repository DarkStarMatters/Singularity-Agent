import type { ChainAdapter } from '../core/adapter.js';
import type {
  BalanceEntry,
  ChainSpec,
  FeeEstimate,
  NormalizedBlock,
  UnsignedTx,
} from '../core/types.js';
import { completeness, sanitizeOnchainText } from '../core/envelope.js';
import {
  HistoricalStateUnsupportedError,
  InvalidAddressError,
  RpcError,
  SingularityError,
  UnsupportedOperationError,
} from '../core/errors.js';
import { amount, nativeAmount, parseUnits, shortAddress } from '../core/format.js';
import { fetchWithFailoverDetail, type FetchOptions } from '../core/http.js';

/**
 * Tessarq: a proof-of-stake chain with Tendermint-style BFT consensus,
 * ML-DSA-65 (post-quantum) signatures, and its own REST-over-HTTP RPC.
 *
 * The node's source is the reference (Quantum-Chain, `crates/tessarq-node/src/rpc.rs`),
 * and every shape below was checked against a running node rather than read
 * off the types alone. What that turned up is written where it applies:
 * amounts arrive as bare JSON integers past 2^53, the minimum fee depends on
 * the protocol version the chain is running, and there is no way to look a
 * transaction up by its hash.
 */

/** 32 bytes of hex: the SHA3-256 of an ML-DSA-65 public key under Tessarq's address domain. */
const ADDRESS = /^(0x)?[0-9a-fA-F]{64}$/;

/** Byte sizes that fix a transaction's length, from `tessarq-core/src/crypto.rs`. */
const PUBLIC_KEY_LEN = 1952;
const SIGNATURE_LEN = 3309;
/** From protocol version 2 the minimum fee scales with size: base units per KiB. `economics.rs`. */
const FEE_PER_KIB_V2 = 1_000_000n;
const U64_MAX = 2n ** 64n - 1n;

// ------------------------------------------------------------------ parsing

/**
 * `JSON.parse`, except integers too long to be exact as a double arrive as strings.
 *
 * Tessarq writes every amount as a bare u64, and balances run to 10^18: a
 * testnet faucet holding 49995998499999990 base units parses through plain
 * `JSON.parse` as 49995998499999992, which is a different balance reported
 * with no sign anything happened. So integer tokens of sixteen digits or more
 * are quoted before parsing, and readers take numbers and strings alike.
 *
 * It walks the text rather than matching a pattern, because string values on
 * this chain include free text (a node's `capability`) that can contain
 * anything a number pattern would match.
 */
export function parseLosslessJson(text: string): unknown {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === '-' || (ch >= '0' && ch <= '9')) {
      let j = i + 1;
      while (j < text.length && /[0-9.eE+-]/.test(text[j]!)) j += 1;
      const token = text.slice(i, j);
      out += /^-?\d{16,}$/.test(token) ? `"${token}"` : token;
      i = j;
      continue;
    }
    out += ch;
    i += 1;
  }
  return JSON.parse(out);
}

/** A u64 as the node wrote it: a number when small, a string when not. */
type U64 = number | string;

function big(value: U64 | undefined, field: string, chain: ChainSpec): bigint {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
  throw new RpcError(chain.id, `the node returned ${field} as ${JSON.stringify(value)}, not an unsigned integer`);
}

function small(value: U64 | undefined, field: string, chain: ChainSpec): number {
  const n = big(value, field, chain);
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RpcError(chain.id, `the node returned ${field} = ${n}, too large to be a height`);
  }
  return Number(n);
}

async function get<T>(chain: ChainSpec, path: string, options: FetchOptions = {}): Promise<T | null> {
  const { data, url } = await fetchWithFailoverDetail<T>(chain, path, { ...options, parse: parseLosslessJson });
  if (data !== null && typeof data !== 'object') {
    throw new RpcError(chain.id, `${path} did not return JSON; is this a Tessarq node's RPC port?`);
  }
  if (path !== '/status') await confirmNetwork(chain, url);
  return data;
}

/** Endpoints already seen serving the configured chain id, as `endpoint|chainId`. */
const confirmed = new Set<string>();

/**
 * Check that the endpoint which answered serves the configured network.
 *
 * Every Tessarq network runs the same software, so a balance read from a node
 * on the wrong one is a well-formed answer about a different chain. Checked per
 * endpoint that actually answered, because failover can move a read to the
 * second node in the list, and once per endpoint, because a node does not
 * change networks under a running process.
 */
async function confirmNetwork(chain: ChainSpec, url: string): Promise<void> {
  if (chain.chainId === undefined) return;
  const endpoint = chain.rpc.find((e) => url.startsWith(e.replace(/\/$/, '')));
  if (!endpoint) return;
  const key = `${endpoint}|${chain.chainId}`;
  if (confirmed.has(key)) return;
  await status({ ...chain, rpc: [endpoint] });
  confirmed.add(key);
}

// ---------------------------------------------------------------- responses

interface Status {
  chain_id: string;
  genesis_hash: string;
  height: U64;
  last_block_hash: string;
  last_time_ms: U64;
  protocol_version: number;
}

interface Account {
  balance: U64;
  nonce: U64;
  vesting: { total?: U64 } | null;
}

interface SignedTx {
  tx: { chain_id: string; nonce: U64; fee: U64; payload: { type: string } };
  signature: string;
}

interface FinalizedBlock {
  block: {
    header: {
      chain_id: string;
      height: U64;
      time_ms: U64;
      prev_hash: string;
      proposer: string;
      state_root: string;
      protocol_version: number;
    };
    txs: SignedTx[];
  };
  cert: { height: U64; round: U64; block_hash: string; precommits: unknown[] };
}

interface AssetInfo {
  id: string;
  symbol: string;
  decimals: number;
  paused: boolean;
}

interface Genesis {
  params: { min_fee: U64 };
}

/**
 * The node's status, checked against what this chain is configured to be.
 *
 * Every Tessarq network runs the same software and differs only in its chain
 * id, so an endpoint answering is no evidence it is answering for the right
 * network. When `chainId` is configured, a node serving another one is refused.
 */
async function status(chain: ChainSpec): Promise<Status> {
  const { data: s, url } = await fetchWithFailoverDetail<Status>(chain, '/status', { parse: parseLosslessJson });
  if (!s || typeof s.chain_id !== 'string' || typeof s.genesis_hash !== 'string') {
    throw new RpcError(chain.id, '/status is not a Tessarq node status', rpcHint(chain));
  }
  if (chain.chainId !== undefined && s.chain_id !== String(chain.chainId)) {
    throw new RpcError(
      chain.id,
      `the node at ${url} serves chain "${s.chain_id}", but ${chain.name} is configured as "${chain.chainId}"`,
      'Point the endpoint at a node of the configured network, or change `chainId` in ~/.singularity/config.json.',
    );
  }
  return s;
}

function rpcHint(chain: ChainSpec): string {
  return (
    `${chain.name} has no public endpoint; this reads a node at ${chain.rpc.join(', ')}. ` +
    'Run one, tunnel to one (ssh -L 8650:127.0.0.1:8650 <server>), or set SINGULARITY_RPC_TESSARQ.'
  );
}

// ------------------------------------------------------------------ helpers

function requireAddress(chain: ChainSpec, address: string): string {
  const value = address.trim();
  if (!ADDRESS.test(value)) {
    throw new InvalidAddressError(address, chain.name, tessarqAdapter.addressExpectation(chain, address));
  }
  // The node prints addresses as bare lowercase hex, and so does everything here.
  return value.replace(/^0x/, '').toLowerCase();
}

function refuseHistorical(chain: ChainSpec, atBlock: number | undefined): void {
  if (atBlock !== undefined) {
    throw new HistoricalStateUnsupportedError(
      chain.id,
      'A Tessarq node serves current state only: its RPC has no height parameter.',
    );
  }
}

function isoFromMs(ms: bigint): string {
  return new Date(Number(ms)).toISOString();
}

/**
 * Borsh length of a signed single-transfer transaction, which the size-based
 * minimum fee is charged on.
 *
 * A string or byte vector is a 4-byte length and its bytes; the payload is a
 * 1-byte variant tag, a 32-byte address and a u64 (a native transfer), or a
 * 32-byte asset id ahead of those (an asset transfer).
 *
 * The native case was checked against a live node under protocol version 2:
 * 5,343 bytes on `tessarq-local`, a predicted fee of 5,217,774 base units, and
 * 5,217,774 charged. The asset case follows from the same type definitions but
 * has not been checked the same way, because a local testnet lists no assets.
 */
export function signedTransferBytes(chainId: string, asset: boolean): number {
  const payload = 1 + (asset ? 32 : 0) + 32 + 8;
  return 4 + Buffer.byteLength(chainId, 'utf8') + 4 + PUBLIC_KEY_LEN + 8 + 8 + payload + 4 + SIGNATURE_LEN;
}

/** `economics::min_fee`: a flat floor, and from protocol version 2 at least a price per KiB. */
export function minimumFee(flatMin: bigint, protocolVersion: number, txBytes: number): bigint {
  if (protocolVersion < 2) return flatMin;
  const sized = (BigInt(txBytes) * FEE_PER_KIB_V2 + 1023n) / 1024n;
  return sized > flatMin ? sized : flatMin;
}

async function transferFee(chain: ChainSpec, s: Status, asset: boolean) {
  const genesis = await get<Genesis>(chain, '/genesis');
  const flatMin = big(genesis?.params?.min_fee, 'params.min_fee', chain);
  const bytes = signedTransferBytes(s.chain_id, asset);
  return { fee: minimumFee(flatMin, s.protocol_version, bytes), flatMin, bytes };
}

async function listedAssets(chain: ChainSpec): Promise<AssetInfo[]> {
  const assets = await get<AssetInfo[]>(chain, '/assets');
  if (!Array.isArray(assets)) throw new RpcError(chain.id, '/assets did not return a list');
  return assets;
}

function assetSymbol(asset: AssetInfo): string {
  // Validators vote an asset onto the chain, symbol included; it is still text
  // the chain stores, so it travels sanitised and marked like any other.
  return sanitizeOnchainText(asset.symbol, 'UNKNOWN');
}

// ------------------------------------------------------------------ adapter

export const tessarqAdapter: ChainAdapter = {
  family: 'tessarq',

  isValidAddress(_chain, address) {
    return ADDRESS.test(address.trim());
  },

  addressExpectation() {
    return '64 hex characters (32 bytes), optionally 0x-prefixed: the SHA3-256 of an ML-DSA-65 public key. The node prints them bare, e.g. 9331ed44…0804.';
  },

  async getNativeBalance(chain, address, options) {
    refuseHistorical(chain, options?.atBlock);
    const owner = requireAddress(chain, address);
    const account = await get<Account>(chain, `/account/${owner}`);
    if (!account) throw new RpcError(chain.id, `/account/${owner} returned nothing`, rpcHint(chain));

    return {
      chain: chain.id,
      address: owner,
      token: {
        symbol: chain.nativeCurrency.symbol,
        name: chain.nativeCurrency.name,
        decimals: chain.nativeCurrency.decimals,
        native: true,
      },
      // The chain's own balance, which counts any still-vesting part: that is
      // what the node reports as `balance`, and what a transfer is checked
      // against after subtracting the unvested amount.
      amount: nativeAmount(big(account.balance, 'balance', chain), chain),
    } satisfies BalanceEntry;
  },

  async getTokenBalances(chain, address, tokens, options) {
    refuseHistorical(chain, options?.atBlock);
    const owner = requireAddress(chain, address);
    const assets = await listedAssets(chain);

    let targets = assets;
    if (tokens?.length) {
      const wanted = tokens.map((t) => requireAddress(chain, t));
      const unknown = wanted.filter((id) => !assets.some((a) => a.id === id));
      if (unknown.length) {
        throw new SingularityError(
          'UNKNOWN_ASSET',
          `${chain.name} lists no bridged asset ${unknown.map((id) => shortAddress(id, 8, 6)).join(', ')}.`,
          'Asset ids come from `tessarq get assets`.',
        );
      }
      targets = assets.filter((a) => wanted.includes(a.id));
    }

    // Every read has to answer. One that fails throws, so a missing balance
    // can never come back looking like a zero one.
    const balances = await Promise.all(
      targets.map(async (asset) => {
        const row = await get<{ amount: U64 }>(chain, `/asset/${asset.id}/balance/${owner}`);
        return { asset, raw: big(row?.amount, `balance of ${asset.id}`, chain) };
      }),
    );

    const entries: BalanceEntry[] = balances
      .filter(({ raw }) => raw > 0n)
      .map(({ asset, raw }) => ({
        chain: chain.id,
        address: owner,
        token: {
          address: asset.id,
          symbol: assetSymbol(asset),
          decimals: asset.decimals,
          native: false,
          untrusted: true,
        },
        amount: amount(raw, asset.decimals, assetSymbol(asset)),
      }));

    return {
      entries,
      completeness: completeness.exhaustive(
        tokens?.length
          ? `The bridged asset(s) you named, each read directly: an asset absent here is held at zero.`
          : `Every bridged asset listed on this chain (${assets.length}), each read directly: an asset absent here is held at zero. TSRQ itself is the native balance, not a listed asset.`,
      ),
    };
  },

  async getTransaction(chain) {
    throw new UnsupportedOperationError(
      'transaction lookup by hash',
      chain.name,
      "A Tessarq node's RPC has no endpoint for it, and a transaction's hash covers its post-quantum signature, so it cannot be recomputed from a block without Tessarq's encoding. Read the effect instead: `balance` shows the recipient's balance, and `block` shows which transactions a block holds.",
    );
  },

  async getBlock(chain, ref) {
    const s = await status(chain);
    const tip = small(s.height, 'height', chain);
    const height = ref === 'latest' || ref === '' ? tip : Number(ref);
    if (!Number.isSafeInteger(height) || height < 1) {
      throw new SingularityError('BAD_BLOCK', `"${ref}" is not a Tessarq block height (1 or more).`);
    }

    const fb = await get<FinalizedBlock>(chain, `/block/${height}`, { nullOn404: true });
    if (!fb) {
      throw new SingularityError(
        'BLOCK_NOT_FOUND',
        height > tip
          ? `Block ${height} has not been produced yet; ${chain.name} is at ${tip}.`
          : `Block ${height} is not held in this node's memory. Nodes keep recent blocks in memory and older ones only in their on-disk log, which the RPC does not serve.`,
      );
    }

    const header = fb.block.header;
    const kinds = fb.block.txs.map((t) => t.tx.payload.type);
    return {
      chain: chain.id,
      number: small(header.height, 'height', chain),
      hash: fb.cert.block_hash,
      timestamp: isoFromMs(big(header.time_ms, 'time_ms', chain)),
      txCount: fb.block.txs.length,
      parentHash: header.prev_hash,
      raw: {
        chainId: header.chain_id,
        proposer: header.proposer,
        protocolVersion: header.protocol_version,
        stateRoot: header.state_root,
        round: small(fb.cert.round, 'round', chain),
        precommits: fb.cert.precommits.length,
        // Variant names from the chain's own enum: the sender picks which, not what it is called.
        txTypes: kinds,
      },
    } satisfies NormalizedBlock;
  },

  async healthCheck(chain) {
    await status(chain);
  },

  async chainTip(chain) {
    const s = await status(chain);
    return {
      height: small(s.height, 'height', chain),
      timestamp: isoFromMs(big(s.last_time_ms, 'last_time_ms', chain)),
    };
  },

  /**
   * The tip, because every block a node serves already carries a commit
   * certificate: precommits from more than two thirds of voting power. The
   * node's `height` is its last finalised block.
   */
  async finalizedHeight(chain) {
    const s = await status(chain);
    return small(s.height, 'height', chain);
  },

  async estimateFees(chain) {
    const s = await status(chain);
    const { fee, flatMin, bytes } = await transferFee(chain, s, false);
    return {
      chain: chain.id,
      simpleTransfer: nativeAmount(fee, chain),
      details: {
        protocolVersion: String(s.protocol_version),
        flatMinimum: `${flatMin} base units`,
        signedTransferBytes: String(bytes),
        rule:
          s.protocol_version < 2
            ? 'protocol version 1: the flat minimum'
            : 'protocol version 2+: the larger of the flat minimum and 1,000,000 base units per KiB of the signed transaction',
      },
      note: `The minimum the chain accepts, computed with its own rule for the protocol version it is running (${s.protocol_version}). There is no fee market: paying more does not include a transaction sooner. The Tessarq CLI pays exactly this by default.`,
    } satisfies FeeEstimate;
  },

  async buildTransfer(chain, params) {
    if (params.memo) {
      throw new SingularityError(
        'MEMO_UNSUPPORTED',
        'Tessarq transfers carry no memo.',
        'Send without one. Dropping it silently would leave you believing it went with the payment.',
      );
    }
    const to = requireAddress(chain, params.to);
    const from = params.from ? requireAddress(chain, params.from) : undefined;
    const s = await status(chain);

    let symbol = chain.nativeCurrency.symbol;
    let decimals = chain.nativeCurrency.decimals;
    let asset: AssetInfo | undefined;
    if (params.token) {
      const id = requireAddress(chain, params.token);
      asset = (await listedAssets(chain)).find((a) => a.id === id);
      if (!asset) {
        throw new SingularityError(
          'UNKNOWN_ASSET',
          `${chain.name} lists no bridged asset ${shortAddress(id, 8, 6)}.`,
          'Asset ids come from `tessarq get assets`.',
        );
      }
      symbol = assetSymbol(asset);
      decimals = asset.decimals;
    }

    const raw = parseUnits(params.amount, decimals);
    if (raw <= 0n || raw > U64_MAX) {
      throw new SingularityError('BAD_AMOUNT', `${params.amount} ${symbol} is not a sendable amount on ${chain.name}.`);
    }
    const { fee } = await transferFee(chain, s, Boolean(asset));

    const warnings = [
      'Singularity cannot sign this and no wallet can: Tessarq keys are ML-DSA-65, and the tessarq CLI builds and signs its own transaction. Check the recipient and amount in the command before you run it.',
      `The amount in the command is in base units: ${raw} is ${params.amount} ${symbol}.`,
      `This node serves chain "${s.chain_id}". The CLI signs for whichever network the --rpc node serves.`,
    ];
    let nonce: string | undefined;
    if (from) {
      const account = await get<Account>(chain, `/account/${from}`);
      if (account) {
        nonce = big(account.nonce, 'nonce', chain).toString();
        const balance = big(account.balance, 'balance', chain);
        if (!asset && balance < raw + fee) {
          warnings.push(
            `${shortAddress(from)} holds ${nativeAmount(balance, chain).formatted} ${chain.nativeCurrency.symbol}, less than the amount plus the ${nativeAmount(fee, chain).formatted} fee. The node will refuse this.`,
          );
        }
        if (account.vesting) {
          warnings.push(`${shortAddress(from)} has a vesting schedule; only the vested part of its balance can be sent.`);
        }
      }
    }
    if (asset?.paused) {
      warnings.push(`${symbol} is paused for minting and withdrawal. Transfers between Tessarq accounts still go through.`);
    }

    const rpc = chain.rpc[0];
    const command = asset
      ? `tessarq asset-transfer --rpc ${rpc} --key <your key file> --asset ${asset.id} --to ${to} --amount ${raw}`
      : `tessarq transfer --rpc ${rpc} --key <your key file> --to ${to} --amount ${raw}`;

    return {
      chain: chain.id,
      family: 'tessarq',
      summary: `Send ${params.amount} ${symbol} to ${shortAddress(to)} on ${chain.name}${from ? ` from ${shortAddress(from)}` : ''}.`,
      payload: {
        chainId: s.chain_id,
        ...(nonce !== undefined ? { nonce } : {}),
        fee: fee.toString(),
        payload: asset
          ? { type: 'transfer_asset', asset: asset.id, to, amount: raw.toString() }
          : { type: 'transfer', to, amount: raw.toString() },
      },
      signingHint: `Run: ${command}\nThe CLI fetches the nonce and pays the minimum fee itself, and the node test-runs the transaction before admitting it. Guide 10 in the Tessarq repository shows building the same transaction with tessarq-core.`,
      warnings,
    } satisfies UnsignedTx;
  },
};
