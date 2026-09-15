import { parseAbi, decodeFunctionData, toFunctionSelector, type Abi } from 'viem';
import type { DecodedCall } from './types.js';

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
 * Decode EVM calldata against the common ABI.
 *
 * Always returns something: an unrecognized selector still comes back with the
 * selector itself and a note, because "I don't know this call" is useful and
 * "no decode field" is not.
 */
export function decodeCalldata(data: string): DecodedCall {
  const hex = data.startsWith('0x') ? data : `0x${data}`;

  if (hex === '0x' || hex.length < 10) {
    return { note: 'No calldata — a plain value transfer.' };
  }

  const selector = hex.slice(0, 10).toLowerCase();
  const signature = SELECTOR_INDEX.get(selector);

  if (!signature) {
    return {
      selector,
      note: `Unrecognized selector ${selector}. Pass the contract's ABI to "decode" for a full decode, or look it up on a 4byte directory.`,
    };
  }

  try {
    const { functionName, args } = decodeFunctionData({ abi: COMMON_ABI, data: hex as `0x${string}` });
    const inputs = inputsFor(signature);
    return {
      selector,
      signature,
      name: functionName,
      args: (args ?? []).map((value, i) => ({
        name: inputs[i]?.name,
        type: inputs[i]?.type,
        value: stringify(value),
      })),
    };
  } catch (err) {
    return {
      selector,
      signature,
      note: `Selector matches ${signature} but the arguments did not decode: ${(err as Error).message}`,
    };
  }
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
    args: (args ?? []).map((value, i) => ({
      name: inputs[i]?.name,
      type: inputs[i]?.type,
      value: stringify(value),
    })),
  };
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

function stringify(value: unknown): string {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return `[${value.map(stringify).join(', ')}]`;
  if (value && typeof value === 'object') {
    return JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  }
  return String(value);
}
