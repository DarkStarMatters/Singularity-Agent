import {
  parseAbi,
  decodeFunctionData,
  decodeEventLog,
  toFunctionSelector,
  toEventSelector,
  type Abi,
} from 'viem';
import { sanitizeOnchainDeep } from './envelope.js';
import type { DecodedArg, DecodedCall, DecodedEvent } from './types.js';

/**
 * Human-readable ABIs for the calls that make up most of what anyone actually
 * looks at on an EVM chain. Enough to turn an opaque 0xa9059cbb blob into
 * "transfer(address,uint256)" without an Etherscan key.
 */
export const COMMON_ABI_SIGNATURES = [
  // ERC-20
  'function transfer(address to, uint256 amount) returns (bool)',
  'function transferFrom(address from, address to, uint256 amount) returns (bool)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function name() view returns (string)',
  // ERC-721 / ERC-1155
  'function safeTransferFrom(address from, address to, uint256 tokenId)',
  'function setApprovalForAll(address operator, bool approved)',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function tokenURI(uint256 tokenId) view returns (string)',
  'function safeTransferFrom(address from, address to, uint256 id, uint256 value, bytes data)',
  // WETH
  'function deposit() payable',
  'function withdraw(uint256 amount)',
  // Multicall / common router shapes
  'function multicall(bytes[] data) returns (bytes[])',
  'function multicall(uint256 deadline, bytes[] data) returns (bytes[])',
  'function multicall(bytes32 previousBlockhash, bytes[] data) returns (bytes[])',
  // Multicall3 — deployed at the same address on every supported EVM chain
  'function aggregate((address target, bytes callData)[] calls) returns (uint256 blockNumber, bytes[] returnData)',
  'function tryAggregate(bool requireSuccess, (address target, bytes callData)[] calls) returns ((bool success, bytes returnData)[])',
  'function aggregate3((address target, bool allowFailure, bytes callData)[] calls) returns ((bool success, bytes returnData)[])',
  'function aggregate3Value((address target, bool allowFailure, uint256 value, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[])',
  // Safe
  'function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)',
  'function multiSend(bytes transactions) payable',
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256)',
  'function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[])',
  'function swapExactETHForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable returns (uint256[])',
] as const;

export const COMMON_ABI: Abi = parseAbi([...COMMON_ABI_SIGNATURES]);

export const ERC20_ABI: Abi = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function name() view returns (string)',
  'function transfer(address to, uint256 amount) returns (bool)',
]);

/** selector -> human signature, built once from COMMON_ABI_SIGNATURES. */
const SELECTOR_INDEX: Map<string, string> = (() => {
  const index = new Map<string, string>();
  for (const signature of COMMON_ABI_SIGNATURES) {
    try {
      index.set(toFunctionSelector(signature).toLowerCase(), signature);
    } catch {
      // A signature viem cannot parse is a bug in the list above, not a runtime
      // condition worth failing startup over.
    }
  }
  return index;
})();

/**
 * How far down a batch this will follow.
 *
 * A multicall can contain a multicall, and a Safe `execTransaction` routinely
 * wraps a `multiSend` that wraps several calls. Four levels covers every real
 * shape; the cap exists because the input is hostile and a self-referential
 * batch would otherwise recurse until the process died.
 */
const MAX_NESTING = 4;

/**
 * Decode EVM calldata against the common ABI.
 *
 * Always returns something: an unrecognized selector still comes back with the
 * selector itself and a note, because "I don't know this call" is useful and
 * "no decode field" is not.
 *
 * Where the call is a wrapper — a multicall, a Multicall3 batch, a Safe
 * `execTransaction` or a `multiSend` — the calls it carries are decoded too and
 * hang off `inner`. Reporting `multicall(bytes[])` and stopping tells a
 * reviewer nothing the selector did not already tell them, and "the thing it
 * actually does is in a bytes argument" describes every batch ever used to make
 * an approval look like a swap.
 */
export function decodeCalldata(data: string): DecodedCall {
  return decodeAt(data, 0);
}

function decodeAt(data: string, depth: number): DecodedCall {
  const hex = data.startsWith('0x') ? data : `0x${data}`;

  if (hex === '0x' || hex.length < 10) {
    return { note: 'No calldata — a plain value transfer.' };
  }

  const selector = hex.slice(0, 10).toLowerCase();
  const signature = SELECTOR_INDEX.get(selector);

  if (!signature) {
    return {
      selector,
      note:
        `Unrecognized selector ${selector}. Pass the contract's ABI to "decode" for a full ` +
        'decode, or set `lookup` to search a public 4-byte directory for candidate signatures.',
    };
  }

  try {
    const { functionName, args } = decodeFunctionData({ abi: COMMON_ABI, data: hex as `0x${string}` });
    const inputs = inputsFor(signature);
    const inner = unwrap(functionName, args ?? [], depth);
    return {
      selector,
      signature,
      name: functionName,
      args: toArgs(args ?? [], inputs),
      ...(inner?.length ? { inner } : {}),
    };
  } catch (err) {
    return {
      selector,
      signature,
      note: `Selector matches ${signature} but the arguments did not decode: ${(err as Error).message}`,
    };
  }
}

/** A nested call that was carried but not followed, because the cap was hit. */
function tooDeep(data: string, target?: string): DecodedCall {
  const hex = data.startsWith('0x') ? data : `0x${data}`;
  return {
    ...(target ? { target } : {}),
    ...(hex.length >= 10 ? { selector: hex.slice(0, 10).toLowerCase() } : {}),
    note: `Nested ${MAX_NESTING} levels deep; not followed further. Decode this calldata on its own to go deeper.`,
  };
}

/**
 * Pull the calls out of a wrapper's arguments.
 *
 * Matched on the decoded function name plus the shape of what it was handed,
 * rather than on the selector, so the same unwrapping covers every router that
 * spells `multicall` the same way. Anything that does not look like a batch
 * returns nothing, which is the common case and must stay cheap.
 */
function unwrap(name: string, args: readonly unknown[], depth: number): DecodedCall[] | undefined {
  const follow = (data: unknown, target?: string): DecodedCall | null => {
    if (typeof data !== 'string' || !data.startsWith('0x')) return null;
    if (depth + 1 >= MAX_NESTING) return tooDeep(data, target);
    const decoded = decodeAt(data, depth + 1);
    return target ? { target, ...decoded } : decoded;
  };

  const batch = (calls: unknown): DecodedCall[] | undefined => {
    if (!Array.isArray(calls)) return undefined;
    const out = calls
      .map((call) => {
        // `bytes[]` gives plain hex; a Multicall3 tuple gives {target, callData}.
        if (typeof call === 'string') return follow(call);
        if (call && typeof call === 'object') {
          const item = call as { target?: unknown; callData?: unknown };
          return follow(item.callData, typeof item.target === 'string' ? item.target : undefined);
        }
        return null;
      })
      .filter((call): call is DecodedCall => call !== null);
    return out.length ? out : undefined;
  };

  switch (name) {
    case 'multicall':
      // Three spellings in the wild; the batch is whichever argument is a list.
      return batch(args.find((arg) => Array.isArray(arg)));
    case 'aggregate':
    case 'aggregate3':
    case 'aggregate3Value':
      return batch(args[0]);
    case 'tryAggregate':
      return batch(args[1]);
    case 'execTransaction': {
      // args: to, value, data, operation, ...
      const call = follow(args[2], typeof args[0] === 'string' ? args[0] : undefined);
      return call ? [call] : undefined;
    }
    case 'multiSend':
      return typeof args[0] === 'string' ? unpackMultiSend(args[0], depth) : undefined;
    default:
      return undefined;
  }
}

/**
 * Unpack a Safe `multiSend` blob.
 *
 * Not ABI-encoded: the transactions are concatenated raw, each one a single
 * operation byte, twenty address bytes, a 32-byte value, a 32-byte data length
 * and then that many bytes of calldata. There is no count and no terminator, so
 * the only way to know how many there are is to walk it.
 *
 * Stops rather than throws on anything that does not fit. This walks bytes an
 * attacker chose, and a blob crafted to run the loop forever or to declare a
 * four-gigabyte payload must cost nothing — the calls already recovered are
 * still genuine, and a note says the rest could not be read.
 */
function unpackMultiSend(blob: string, depth: number): DecodedCall[] | undefined {
  const hex = blob.startsWith('0x') ? blob.slice(2) : blob;
  const calls: DecodedCall[] = [];
  let at = 0;

  while (at < hex.length) {
    // operation(1) + to(20) + value(32) + dataLength(32) = 85 bytes = 170 chars
    if (at + 170 > hex.length) {
      calls.push({ note: 'Trailing bytes here are too short to be another transaction.' });
      break;
    }
    const to = `0x${hex.slice(at + 2, at + 42)}`;
    const length = Number(BigInt(`0x${hex.slice(at + 106, at + 170)}`));
    const start = at + 170;
    const end = start + length * 2;

    if (!Number.isSafeInteger(length) || end > hex.length) {
      calls.push({
        target: to,
        note: 'This transaction declares more calldata than the blob contains; the rest was not read.',
      });
      break;
    }

    const data = `0x${hex.slice(start, end)}`;
    calls.push(
      depth + 1 >= MAX_NESTING ? tooDeep(data, to) : { target: to, ...decodeAt(data, depth + 1) },
    );
    at = end;

    if (calls.length >= 64) {
      calls.push({ note: 'Stopped after 64 transactions; decode the remainder on its own.' });
      break;
    }
  }

  return calls.length ? calls : undefined;
}

/**
 * Turn decoded values into arguments, marking the ones that carry text.
 *
 * Both decoders funnel through here so the mark cannot be applied in one path
 * and forgotten in the other — which is the shape of every bug this file's
 * neighbours exist to prevent.
 */
function toArgs(
  values: readonly unknown[],
  inputs: Array<{ name?: string; type?: string }>,
): NonNullable<DecodedCall['args']> {
  return values.map((value, i) => {
    const type = inputs[i]?.type;
    return {
      name: inputs[i]?.name,
      type,
      value: stringify(value),
      ...(carriesText(type) ? { untrusted: true as const } : {}),
    };
  });
}

/**
 * Can an argument of this type hold prose?
 *
 * `string` can, at any depth — `string`, `string[]`, and the tuple
 * `(address,string,uint256)` all reduce to the same question. `bytes` renders
 * as hex and `uint256` as digits; neither can be read as an instruction, and
 * marking them would train a reader to ignore the mark.
 *
 * An **unknown** type is marked. That is the whole point of writing this as a
 * question about the type rather than about the value: when `decode` is handed
 * an ABI whose signature does not match the call, there are no types at all,
 * and the safe default there is to distrust everything rather than to wave
 * through a decode nobody could name.
 */
export function carriesText(type: string | undefined): boolean {
  return type === undefined || type.includes('string');
}

/** Decode against a caller-supplied human-readable ABI. */
export function decodeWithAbi(data: string, abiSignatures: string[]): DecodedCall {
  const abi = parseAbi(abiSignatures);
  const hex = (data.startsWith('0x') ? data : `0x${data}`) as `0x${string}`;
  const { functionName, args } = decodeFunctionData({ abi, data: hex });
  const matched = abiSignatures.find((s) => s.includes(`${functionName}(`));
  const inputs = matched ? inputsFor(matched) : [];
  return {
    selector: hex.slice(0, 10).toLowerCase(),
    signature: matched,
    name: functionName,
    args: toArgs(args ?? [], inputs),
  };
}

// ---- Events --------------------------------------------------------------

/**
 * The events worth recognizing on sight.
 *
 * Calldata says what was asked for; logs say what happened. On anything that
 * routed through an aggregator those are different answers, and the second one
 * is usually the question being asked.
 */
export const COMMON_EVENT_SIGNATURES = [
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'event Approval(address indexed owner, address indexed spender, uint256 value)',
  'event ApprovalForAll(address indexed owner, address indexed operator, bool approved)',
  'event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)',
  'event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values)',
  'event Deposit(address indexed dst, uint256 wad)',
  'event Withdrawal(address indexed src, uint256 wad)',
] as const;

/**
 * ERC-721's Transfer, which shares ERC-20's topic and is a different event.
 *
 * `Transfer(address,address,uint256)` hashes to one topic whether the last
 * argument is indexed or not, so the two are indistinguishable by topic alone.
 * They are told apart by how many topics the log carries: three for ERC-20
 * (signature plus two indexed addresses), four for ERC-721 (the token id is
 * indexed as well). Getting this backwards decodes a token id as an amount,
 * which is how "transferred 4,512 tokens" gets written about NFT #4512.
 */
const ERC721_TRANSFER =
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)';

const COMMON_EVENTS: Abi = parseAbi([...COMMON_EVENT_SIGNATURES]);
const ERC721_TRANSFER_ABI: Abi = parseAbi([ERC721_TRANSFER]);

/** topic0 -> human signature. */
const EVENT_INDEX: Map<string, string> = (() => {
  const index = new Map<string, string>();
  for (const signature of COMMON_EVENT_SIGNATURES) {
    try {
      index.set(toEventSelector(signature).toLowerCase(), signature);
    } catch {
      // A signature viem cannot parse is a bug in the list above.
    }
  }
  return index;
})();

/** One raw log, in the shape every EVM client returns it. */
export interface RawLog {
  address: string;
  topics: readonly string[];
  data: string;
}

/**
 * Decode a receipt's logs.
 *
 * Unrecognized logs are kept rather than dropped, carrying their topic and a
 * note. A transaction whose interesting event is the one this tool does not
 * know would otherwise look like a transaction that emitted nothing, and an
 * empty `events` list reading as "nothing happened" is the same bug as an
 * empty token list reading as "holds nothing".
 */
export function decodeLogs(logs: readonly RawLog[]): DecodedEvent[] {
  return logs.map((log) => {
    const topic = (log.topics[0] ?? '').toLowerCase();
    const signature = EVENT_INDEX.get(topic);

    if (!signature) {
      return {
        address: log.address,
        topic,
        note: 'Unrecognized event. The topic is the keccak hash of its signature; look it up to identify it.',
      };
    }

    // Both Transfers hash alike, so the topic count decides which this is.
    const erc721 = signature.startsWith('event Transfer(') && log.topics.length === 4;
    const abi = erc721 ? ERC721_TRANSFER_ABI : COMMON_EVENTS;

    try {
      const decoded = decodeEventLog({
        abi,
        topics: log.topics as [signature: `0x${string}`, ...args: `0x${string}`[]],
        data: log.data as `0x${string}`,
      });
      const used = erc721 ? ERC721_TRANSFER : signature;
      // `inputsFor` splits "address indexed from" into type and trailing name,
      // so the `indexed` keyword falls out on its own with nothing extra.
      const inputs = inputsFor(used);
      // viem returns positional args for an unnamed ABI and an object for a
      // named one. These signatures name everything, so the object path is the
      // live one; the array branch is there so a future unnamed entry does not
      // silently produce a row of `undefined` values.
      const named = decoded.args as unknown;
      const values = Array.isArray(named)
        ? named
        : inputs.map((input) => (named as Record<string, unknown>)?.[input.name ?? '']);

      return {
        address: log.address,
        signature: used,
        name: decoded.eventName,
        topic,
        args: toArgs(values, inputs),
      };
    } catch (err) {
      return {
        address: log.address,
        signature,
        topic,
        note: `Topic matches ${signature} but the log did not decode: ${(err as Error).message}`,
      };
    }
  });
}


/** Pull `(name, type)` pairs out of a human-readable signature, best effort. */
function inputsFor(signature: string): Array<{ name?: string; type?: string }> {
  const open = signature.indexOf('(');
  if (open === -1) return [];
  let depth = 0;
  let close = -1;
  for (let i = open; i < signature.length; i++) {
    if (signature[i] === '(') depth++;
    else if (signature[i] === ')') {
      depth--;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close === -1) return [];

  const inner = signature.slice(open + 1, close);
  if (!inner.trim()) return [];

  return splitTopLevel(inner).map((part) => {
    const tokens = part.trim().split(/\s+/);
    if (tokens.length === 1) return { type: tokens[0] };
    return { type: tokens[0], name: tokens[tokens.length - 1] };
  });
}

/** Split on commas that are not inside a nested tuple. */
function splitTopLevel(input: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of input) {
    if (char === '(') depth++;
    if (char === ')') depth--;
    if (char === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim()) parts.push(current);
  return parts;
}

/**
 * Render a decoded value, with any text in it defanged first.
 *
 * The sanitizing happens at the leaves rather than on the finished string,
 * because a tuple serializes to JSON and stripping *that* of braces and control
 * characters would leave something neither readable nor parseable. Addresses,
 * numbers and hex pass through the sanitizer untouched, so this costs nothing
 * on the arguments that make up almost every call.
 */
function stringify(value: unknown): string {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string') return sanitizeOnchainDeep(value);
  if (Array.isArray(value)) return `[${value.map(stringify).join(', ')}]`;
  if (value && typeof value === 'object') {
    return JSON.stringify(sanitizeOnchainDeep(value), (_k, v) =>
      typeof v === 'bigint' ? v.toString() : v,
    );
  }
  return String(value);
}
