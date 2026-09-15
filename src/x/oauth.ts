/**
 * OAuth 1.0a request signing (HMAC-SHA1), which is what X still requires for
 * user-context writes. The bearer token is app-only and read-only — it cannot
 * publish a post, so there is no way around signing here.
 *
 * Implemented directly rather than pulled in, because every OAuth 1.0a library
 * wants the consumer secret and the access secret, and this is ~60 lines of
 * well-specified string building (RFC 5849 §3.4).
 */
import { createHmac, randomBytes } from 'node:crypto';

export interface OAuthCredentials {
  apiKey: string;
  apiSecret: string;
  accessToken: string;
  accessSecret: string;
}

/**
 * RFC 3986 percent-encoding. `encodeURIComponent` leaves `!*'()` alone, and
 * X rejects the signature if those are not escaped — a classic silent 401.
 */
export function percentEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!*'()]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * Builds the `Authorization: OAuth …` header.
 *
 * `bodyParams` must contain the request's form fields for a form-encoded body,
 * and must be empty for a JSON body — X signs JSON bodies as if they were
 * absent, and including them produces a signature mismatch.
 */
export function buildAuthHeader(
  method: 'GET' | 'POST' | 'DELETE',
  url: string,
  credentials: OAuthCredentials,
  bodyParams: Record<string, string> = {},
  nonce = randomBytes(16).toString('hex'),
  timestamp = Math.floor(Date.now() / 1000),
): string {
  const target = new URL(url);

  const oauthParams: Record<string, string> = {
    oauth_consumer_key: credentials.apiKey,
    oauth_nonce: nonce,
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(timestamp),
    oauth_token: credentials.accessToken,
    oauth_version: '1.0',
  };

  // Query string params are signed too, and the base URL must exclude them.
  const queryParams: Record<string, string> = {};
  for (const [key, value] of target.searchParams) queryParams[key] = value;

  const signature = sign(
    method,
    `${target.origin}${target.pathname}`,
    { ...oauthParams, ...queryParams, ...bodyParams },
    credentials,
  );

  // Annotated, or the spread infers a closed object type that cannot be
  // indexed by the sorted key below.
  const header: Record<string, string> = { ...oauthParams, oauth_signature: signature };

  return (
    'OAuth ' +
    Object.keys(header)
      .sort()
      .map((key) => `${percentEncode(key)}="${percentEncode(header[key]!)}"`)
      .join(', ')
  );
}

function sign(
  method: string,
  baseUrl: string,
  params: Record<string, string>,
  credentials: OAuthCredentials,
): string {
  // Parameters are sorted by encoded key, then encoded value.
  const normalized = Object.keys(params)
    .map((key) => [percentEncode(key), percentEncode(params[key]!)] as const)
    .sort(([aKey, aVal], [bKey, bVal]) => (aKey === bKey ? compare(aVal, bVal) : compare(aKey, bKey)))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');

  const baseString = [
    method.toUpperCase(),
    percentEncode(baseUrl),
    percentEncode(normalized),
  ].join('&');

  const signingKey = `${percentEncode(credentials.apiSecret)}&${percentEncode(credentials.accessSecret)}`;

  return createHmac('sha1', signingKey).update(baseString).digest('base64');
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
