/**
 * Asking a stranger what a selector means.
 *
 * A function selector is the first four bytes of the keccak hash of a
 * signature. Four bytes is not enough to be an identity: collisions are cheap
 * to manufacture deliberately, and public 4-byte directories accept
 * submissions from anyone with no verification at all. That is what makes them
 * useful — they have seen far more contracts than this repo's curated list ever
 * will — and it is also exactly why an answer from one cannot be treated the
 * way a local match is treated.
 *
 * So the result never becomes `signature`. `signature` means *this tool
 * recognized the call*. A directory answer means *somebody once submitted this
 * text for these four bytes*, and it arrives as a `candidate`, marked
 * `untrusted`, in a list, alongside every other answer the directory gave. When
 * two candidates both decode the calldata cleanly there is no evidence for
 * either and this reports both rather than picking — the alternative is a
 * confident wrong answer, which is the one outcome this repo is organized
 * against.
 *
 * The lookup is **off unless asked for**. It sends the selector you are looking
 * at to a third party, which is a disclosure the caller should make on purpose
 * rather than discover later.
 */
import { decodeFunctionData, parseAbi } from 'viem';
import { sanitizeOnchainText } from './envelope.js';
import type { DecodedArg, SelectorCandidate } from './types.js';

const DIRECTORY = 'https://www.4byte.directory/api/v1/signatures/';

/** Enough to identify a call; far past this is somebody testing the field. */
const MAX_CANDIDATES = 10;

interface DirectoryResponse {
  results?: Array<{ text_signature?: unknown }>;
}

/**
 * Ask the directory what this selector might be.
 *
 * Returns an empty list on any failure — a network error, a rate limit, a
 * malformed body. The caller's note already says the selector is unrecognized,
 * and "the directory was unreachable" does not change what is known about the
 * calldata. It is the one place in this repo where swallowing a failure is
 * right, because the failure removes nothing: no lookup and a failed lookup
 * leave the caller with exactly the same information.
 */
export async function lookupSelector(
  selector: string,
  data: string,
  timeoutMs = Number(process.env.SINGULARITY_TIMEOUT_MS ?? 15_000),
): Promise<SelectorCandidate[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let body: DirectoryResponse;
  try {
    const response = await fetch(`${DIRECTORY}?hex_signature=${encodeURIComponent(selector)}`, {
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) return [];
    body = (await response.json()) as DirectoryResponse;
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }

  const signatures = (body.results ?? [])
    .map((row) => sanitizeOnchainText(row.text_signature, '', 128))
    .filter(Boolean)
    .slice(0, MAX_CANDIDATES);

  // Which of them actually fit the bytes in hand. A directory entry that cannot
  // decode this calldata is not a candidate for *this* call, whatever it is a
  // candidate for elsewhere.
  const decoded = signatures.map((signature) => ({
    signature,
    args: tryDecode(signature, data),
  }));
  const fitting = decoded.filter((entry) => entry.args !== null);

  return decoded.map(({ signature, args }) => ({
    signature,
    untrusted: true as const,
    // Arguments only when exactly one candidate fits. Two that both decode is
    // two stories about the same bytes, and choosing between them would be the
    // guess this tool exists not to make.
    ...(fitting.length === 1 && args ? { args } : {}),
  }));
}

/**
 * Decode against a candidate, or say it does not fit.
 *
 * The signature came off the public internet, so `parseAbi` is as likely to be
 * handed something unparseable as something real, and neither is exceptional.
 */
function tryDecode(signature: string, data: string): DecodedArg[] | null {
  try {
    // The signature is a runtime string from the network, so the literal
    // types `parseAbi` infers from a constant cannot apply. It still throws
    // on anything it cannot parse, which is the branch that matters here.
    const abi = parseAbi([`function ${signature}`] as unknown as readonly string[]);
    const { args } = decodeFunctionData({ abi, data: data as `0x${string}` });
    return (args ?? []).map((value, index) => ({
      // A directory signature names types and nothing else, so there are no
      // argument names to report — and inventing them would be inventing
      // meaning the source never claimed.
      type: typeAt(signature, index),
      value: stringifyValue(value),
      untrusted: true as const,
    }));
  } catch {
    return null;
  }
}

/** The nth type in `name(type,type,…)`, ignoring nesting. */
function typeAt(signature: string, index: number): string | undefined {
  const open = signature.indexOf('(');
  const close = signature.lastIndexOf(')');
  if (open === -1 || close <= open) return undefined;

  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of signature.slice(open + 1, close)) {
    if (char === '(') depth++;
    if (char === ')') depth--;
    if (char === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim()) parts.push(current.trim());
  return parts[index];
}

function stringifyValue(value: unknown): string {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string') return sanitizeOnchainText(value, '', 256);
  if (Array.isArray(value)) return `[${value.map(stringifyValue).join(', ')}]`;
  if (value && typeof value === 'object') {
    return JSON.stringify(value, (_key, nested) =>
      typeof nested === 'bigint' ? nested.toString() : nested,
    );
  }
  return String(value);
}
