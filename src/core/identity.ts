/**
 * The document a mint points at, and whether it can change under you.
 *
 * A project's canonical accounts normally live in a bio — editable, copyable,
 * and impossible to check. A Token-2022 mint can do better: if its metadata
 * update authority is revoked and the uri addresses its content rather than a
 * location, then the accounts it declares are what the deployer published when
 * the mint was made, and nobody can swap them later. That is a claim worth
 * reading, and it is the reason this file is separate from the mint audit —
 * `mint_audit` reports the uri and deliberately never fetches it.
 *
 * Fetching is opt-in for the reason that rule exists: the uri is a URL chosen
 * by whoever deployed the mint, so reading it turns a chain read into an
 * outbound request to an address of their choosing, from whatever host this
 * runs on. The caller decides that, the same way `decode --lookup` makes
 * disclosing a selector to a third party a deliberate act.
 */
import { createHash } from 'node:crypto';
import { untrustedText, type UntrustedText } from './envelope.js';
import { SingularityError } from './errors.js';
import type { DeclaredAccount } from './types.js';

/** Where an `ipfs://` uri is read from. A gateway is a third party; naming it is the point. */
function gateway(): string {
  return process.env.SINGULARITY_IPFS_GATEWAY || 'https://ipfs.io/ipfs/';
}

const CID_V0 = /\bQm[1-9A-HJ-NP-Za-km-z]{44}\b/;
const CID_V1 = /\bb[a-z2-7]{58,}\b/;

/**
 * Does this uri address its content, or merely a place?
 *
 * An IPFS CID is a hash of the document, so the bytes it names cannot change
 * without the name changing. An ordinary https path names a server, and a
 * server can serve anything tomorrow — including to some readers and not
 * others. The difference decides whether "immutable metadata" means the text
 * on chain or the whole record, and conflating the two would let a mutable
 * document ride on an immutable pointer.
 */
export function isContentAddressed(uri: string): boolean {
  return CID_V0.test(uri) || CID_V1.test(uri);
}

/** The CID in a uri, wherever it sits: an `ipfs://` scheme or a gateway path. */
export function extractCid(uri: string): string | undefined {
  return uri.match(CID_V1)?.[0] ?? uri.match(CID_V0)?.[0];
}

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

/** RFC 4648 base32, lower case, unpadded — how a CIDv1 is written. */
function decodeBase32(text: string): Uint8Array | undefined {
  let bits = 0;
  let value = 0;
  const out: number[] = [];

  for (const character of text) {
    const index = BASE32.indexOf(character);
    if (index < 0) return undefined;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }

  return new Uint8Array(out);
}

export type CidCheck = 'verified' | 'mismatch' | 'not-checkable';

/**
 * Check that a document really is the one its CID names.
 *
 * Without this, "content-addressed" is a property of the *format* rather than
 * of the answer: the bytes still arrive from whatever gateway is in the URL,
 * and a gateway is a server like any other. A CIDv1 over the raw codec is a
 * sha-256 of exactly these bytes, so it costs one hash to turn the claim into
 * a check — and once it is checked, reading the same CID from a different
 * gateway is equally safe, which is what makes a fallback possible at all.
 *
 * A dag-pb CID (every `Qm…`, and the `bafybei…` a large file gets) hashes a
 * UnixFS node rather than the file, and reconstructing that is a different
 * project. Those come back `not-checkable` and say so, rather than being
 * quietly reported as verified.
 */
export function verifyCid(cid: string, bytes: Buffer): CidCheck {
  if (!cid.startsWith('b')) return 'not-checkable';

  const decoded = decodeBase32(cid.slice(1));
  if (!decoded || decoded.length < 36) return 'not-checkable';

  const [version, codec, hashCode, hashLength] = decoded;
  // v1, raw codec, sha2-256, 32 bytes. Anything else is a shape this does
  // not claim to understand.
  if (version !== 0x01 || codec !== 0x55 || hashCode !== 0x12 || hashLength !== 0x20) {
    return 'not-checkable';
  }

  const digest = Buffer.from(decoded.subarray(4, 36));
  return createHash('sha256').update(bytes).digest().equals(digest) ? 'verified' : 'mismatch';
}

/** `ipfs://CID/path` is not a URL anything can fetch; a gateway makes it one. */
export function resolveUri(uri: string): string {
  const trimmed = uri.trim();
  if (!trimmed.toLowerCase().startsWith('ipfs://')) return trimmed;
  return `${gateway()}${trimmed.slice('ipfs://'.length)}`;
}

/** Hostnames that must never be fetched on behalf of a string from a stranger. */
function isLocal(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  // Any IP literal, v4 or v6. A document worth publishing has a name.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true;
  if (host.includes(':')) return true;
  return false;
}

const FETCH_TIMEOUT_MS = 8_000;
/** A metadata document is a handful of fields. Anything larger is not one. */
const MAX_DOCUMENT_BYTES = 64 * 1024;

export interface IdentityDocument {
  source: string;
  accounts: DeclaredAccount[];
  /** Whether the bytes were checked against the CID the mint names. */
  integrity: CidCheck;
}

const ACCOUNT_KEYS: Array<{ keys: string[]; kind: DeclaredAccount['kind'] }> = [
  { keys: ['twitter', 'x'], kind: 'x' },
  { keys: ['telegram'], kind: 'telegram' },
  { keys: ['website', 'site', 'url'], kind: 'website' },
  { keys: ['github'], kind: 'github' },
  { keys: ['discord'], kind: 'discord' },
];

/**
 * Pull declared accounts out of a metadata document.
 *
 * Both shapes in the wild: the flat one pump.fun writes, and the `extensions`
 * object Metaplex specifies. Anything recognized is reported with its kind;
 * anything else is left alone rather than guessed at, because a key this tool
 * does not know is not evidence of an account.
 */
export function readAccounts(document: unknown): DeclaredAccount[] {
  if (!document || typeof document !== 'object') return [];

  const root = document as Record<string, unknown>;
  const extensions =
    root.extensions && typeof root.extensions === 'object'
      ? (root.extensions as Record<string, unknown>)
      : {};

  const accounts: DeclaredAccount[] = [];
  const seen = new Set<string>();

  for (const { keys, kind } of ACCOUNT_KEYS) {
    for (const key of keys) {
      const raw = root[key] ?? extensions[key];
      if (typeof raw !== 'string' || !raw.trim()) continue;

      const value = untrustedText(raw, 'declared in the document this mint points at');
      if (!value || seen.has(`${kind}:${value.text}`)) continue;

      seen.add(`${kind}:${value.text}`);
      accounts.push({ kind, value });
    }
  }

  return accounts;
}

/**
 * Fetch and read the document, or say precisely why not.
 *
 * Never returns an empty document on failure. "This mint declares no accounts"
 * and "the fetch failed" are the same empty array, and the first is a finding
 * while the second is a gap — the caller is made to tell them apart.
 */
export async function fetchIdentityDocument(uri: string): Promise<IdentityDocument> {
  const cid = extractCid(uri);

  try {
    return await readDocument(resolveUri(uri), cid);
  } catch (err) {
    // One retry, and only for content-addressed documents. A public gateway
    // rate-limiting a request says nothing about the document, and the whole
    // point of a CID is that another server holding the same bytes is the same
    // answer — which is only true because those bytes get hashed on arrival.
    const fallback = cid ? `${gateway()}${cid}` : undefined;
    if (!fallback || fallback === resolveUri(uri)) throw err;
    return readDocument(fallback, cid);
  }
}

async function readDocument(source: string, cid: string | undefined): Promise<IdentityDocument> {

  let url: URL;
  try {
    url = new URL(source);
  } catch {
    throw new SingularityError(
      'BAD_METADATA_URI',
      `The metadata link is not a URL that can be fetched: ${source.slice(0, 80)}`,
      'Some mints point at nothing fetchable at all. That is a fact about the mint, not an error to work around.',
    );
  }

  if (url.protocol !== 'https:') {
    throw new SingularityError(
      'UNSAFE_METADATA_URI',
      `The metadata link is ${url.protocol.replace(':', '')}, and only https is fetched.`,
      'The link is chosen by whoever deployed the mint, so it is not followed to a scheme that carries no transport security.',
    );
  }

  if (isLocal(url.hostname)) {
    throw new SingularityError(
      'UNSAFE_METADATA_URI',
      `The metadata link points at ${url.hostname}, which is not fetched.`,
      'A string written by a stranger must never make this tool fetch from the machine it is running on or from a bare IP. That is a request to your network, made on their say-so.',
    );
  }

  let response: Response;
  try {
    response = await fetch(source, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: 'follow',
      headers: { accept: 'application/json' },
    });
  } catch (err) {
    throw new SingularityError(
      'METADATA_FETCH_FAILED',
      `The metadata document could not be fetched: ${(err as Error).message}`,
      'A document that cannot be read is not a document that says nothing.',
    );
  }

  // Redirects are followed, so the check above has to hold at the far end too:
  // an https link that lands on a private host has done exactly what the
  // hostname rule exists to stop.
  const landed = new URL(response.url || source);
  if (landed.protocol !== 'https:' || isLocal(landed.hostname)) {
    throw new SingularityError(
      'UNSAFE_METADATA_URI',
      `The metadata link redirected to ${landed.hostname}, which is not fetched.`,
      'The destination is checked after redirects as well as before them.',
    );
  }

  if (!response.ok) {
    throw new SingularityError(
      'METADATA_FETCH_FAILED',
      `The metadata document answered ${response.status}.`,
      'The link is on the mint forever; whatever is serving it today is not.',
    );
  }

  const body = Buffer.from(await response.arrayBuffer()).subarray(0, MAX_DOCUMENT_BYTES);
  const integrity = cid ? verifyCid(cid, body) : 'not-checkable';

  if (integrity === 'mismatch') {
    throw new SingularityError(
      'METADATA_CID_MISMATCH',
      `The document served does not hash to ${cid}, the CID this mint names.`,
      'The mint names one document and the gateway served another. Nothing here is evidence of what the deployer published — treat the gateway as compromised or misconfigured, not the answer as approximate.',
    );
  }

  const text = body.toString('utf8');

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new SingularityError(
      'METADATA_NOT_JSON',
      'The metadata document is not JSON, so no accounts could be read from it.',
      'It may be an image or a web page. The uri is reported either way.',
    );
  }

  return { source, accounts: readAccounts(parsed), integrity };
}

export type { UntrustedText };
