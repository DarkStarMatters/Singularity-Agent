/**
 * The Kant zk-relay: how lean-worker agents hand results to each other.
 *
 * Implemented exactly as `minimal/tasks/template.json` specifies it:
 *
 *   key        = SHA256(task_id + ":" + shared_salt)
 *   iv         = 12 random bytes                       → sent as hex
 *   ct_with_tag = AES-256-GCM(key).encrypt(iv, plaintext, no AAD)
 *   encrypted  = base64(ct_with_tag[:-16]), tag = hex(ct_with_tag[-16:])
 *   room       = SHA256(shared_salt + ":" + agent_id)[:16]
 *
 * The room and key derivations reproduce every `room_id` and `enc_key` in
 * upstream's `agent-a.json` and `agent-b.json` (see `test/relay.test.ts`), and
 * the cipher was cross-checked against Python's `cryptography` AESGCM, the
 * library the upstream instructions name.
 *
 * Two things the envelope is not, and every function here says so in what it
 * returns rather than leaving it to a README:
 *
 *  - Confidential. The shared salt is committed to the public repository, so
 *    anyone can derive every key. `sealedWithPublicSalt` flags it.
 *  - Authenticated as to sender. GCM proves the ciphertext was made by someone
 *    holding the key, which is everyone; `agent` is an unauthenticated label.
 *    For a result someone must be able to rely on, send a lean-link
 *    certificate inside the envelope — its tag is what binds it to a node.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';

export const DEFAULT_RELAY = 'https://kant-zk-relay.jmikedupont2.workers.dev';
export const PUBLIC_ROOM = 'agent-zoo-public';

/** The salt committed in upstream's task files, i.e. known to everyone. */
export const PUBLIC_SALTS = new Set(['twin-proof-wave-vi-xii-2026-09-17-mike']);

/** Upstream says Cloudflare's WAF rejects requests without these. */
const HEADERS = {
  'Content-Type': 'application/json',
  'User-Agent': 'lean-worker/1.0 (Aristotle proof agent)',
  Accept: 'application/json',
};

export interface Envelope {
  encrypted: string;
  iv: string;
  tag: string;
  agent: string;
  task: string;
  ts: string;
}

export const EnvelopeSchema: z.ZodType<Envelope> = z.object({
  encrypted: z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/, 'base64'),
  iv: z.string().regex(/^[0-9a-f]{24}$/i, '12 bytes of hex'),
  tag: z.string().regex(/^[0-9a-f]{32}$/i, '16 bytes of hex'),
  agent: z.string().min(1).max(128),
  task: z.string().min(1).max(256),
  ts: z.string().min(1).max(64),
});

/** The plaintext lean-worker agents put in an envelope (`template.json` → `result_format`). */
export const TaskResultSchema = z.object({
  compiled: z.boolean(),
  theorems_proved: z.number().int().nonnegative(),
  sorrys_remaining: z.number().int().nonnegative(),
  warnings: z.number().int().nonnegative(),
  files_changed: z.array(z.string()),
  theorems_added: z.array(z.string()),
  total_theorems: z.number().int().nonnegative(),
  total_sorrys: z.number().int().nonnegative(),
  log: z.string().optional(),
  error: z.string().optional(),
}).passthrough();

export type TaskResult = z.infer<typeof TaskResultSchema>;

export function taskKey(taskId: string, salt: string): Buffer {
  return createHash('sha256').update(`${taskId}:${salt}`, 'utf8').digest();
}

export function roomId(salt: string, agentId: string): string {
  return createHash('sha256').update(`${salt}:${agentId}`, 'utf8').digest('hex').slice(0, 16);
}

export function sealedWithPublicSalt(salt: string): boolean {
  return PUBLIC_SALTS.has(salt);
}

export function seal(
  plaintext: string,
  options: { task: string; salt: string; agent: string; ts?: string; iv?: Buffer },
): Envelope {
  const iv = options.iv ?? randomBytes(12);
  if (iv.length !== 12) throw new RangeError('the relay format uses a 12-byte IV');
  const cipher = createCipheriv('aes-256-gcm', taskKey(options.task, options.salt), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    encrypted: ciphertext.toString('base64'),
    iv: iv.toString('hex'),
    tag: cipher.getAuthTag().toString('hex'),
    agent: options.agent,
    task: options.task,
    ts: options.ts ?? new Date().toISOString(),
  };
}

export class EnvelopeError extends Error {
  constructor(message: string, readonly code: 'BAD_ENVELOPE' | 'WRONG_KEY') {
    super(message);
  }
}

/** Decrypt with the key for `envelope.task`. A wrong salt or a tampered byte is `WRONG_KEY`: GCM cannot tell them apart. */
export function open(envelope: Envelope, salt: string): string {
  const parsed = EnvelopeSchema.safeParse(envelope);
  if (!parsed.success) throw new EnvelopeError(`not a relay envelope: ${parsed.error.issues[0]?.message}`, 'BAD_ENVELOPE');
  const decipher = createDecipheriv('aes-256-gcm', taskKey(envelope.task, salt), Buffer.from(envelope.iv, 'hex'));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'hex'));
  try {
    return Buffer.concat([decipher.update(Buffer.from(envelope.encrypted, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    throw new EnvelopeError(
      `the envelope for task "${envelope.task}" does not decrypt under that salt — wrong salt, wrong task id, or the envelope was altered`,
      'WRONG_KEY',
    );
  }
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

export class RelayError extends Error {
  constructor(message: string, readonly code: string, readonly status?: number, readonly hint?: string) {
    super(message);
  }
}

function relayUrl(base: string, path: string): string {
  return new URL(path, base.endsWith('/') ? base : `${base}/`).toString();
}

/**
 * Turn a non-2xx answer into something actionable. Cloudflare's own error
 * pages carry a code in the body (`error code: 1042`), which says more than
 * the HTTP status: 1042 means the Worker is not deployed at all, 1010 that the
 * WAF refused the request before it reached the Worker.
 */
function failure(status: number, body: string): RelayError {
  const cf = /error code:\s*(\d{4})/i.exec(body)?.[1];
  if (cf === '1042') {
    return new RelayError('the relay Worker is not deployed (Cloudflare 1042)', 'RELAY_DOWN', status, 'Nothing on this side can fix it: the relay operator has to redeploy it, or pass a different relay URL.');
  }
  if (cf === '1010' || status === 403) {
    return new RelayError(`the relay refused the request (HTTP ${status}${cf ? `, Cloudflare ${cf}` : ''})`, 'RELAY_FORBIDDEN', status, 'Upstream says not to retry a 403: check the URL and room id first.');
  }
  return new RelayError(`the relay answered HTTP ${status}: ${body.slice(0, 200)}`, 'RELAY_ERROR', status);
}

export interface RelayOptions {
  base?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

async function request(path: string, init: RequestInit, options: RelayOptions): Promise<unknown> {
  const doFetch = options.fetchImpl ?? fetch;
  const url = relayUrl(options.base ?? DEFAULT_RELAY, path);
  let res: Response;
  try {
    res = await doFetch(url, { ...init, headers: HEADERS, signal: AbortSignal.timeout(options.timeoutMs ?? 15_000) });
  } catch (err) {
    throw new RelayError(`could not reach the relay at ${url}: ${(err as Error).message}`, 'RELAY_UNREACHABLE');
  }
  const text = await res.text();
  if (!res.ok) throw failure(res.status, text);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export function relayHealth(options: RelayOptions = {}): Promise<unknown> {
  return request('health', { method: 'GET' }, options);
}

/**
 * Read a room. Upstream never documents the shape of a room listing, and the
 * relay has been down since before this was written, so this accepts an array
 * of envelopes or any object holding one, and reports what it could not read.
 */
export async function readRoom(room: string, options: RelayOptions = {}): Promise<{ envelopes: Envelope[]; unreadable: number; raw?: unknown }> {
  const body = await request(`room/${encodeURIComponent(room)}`, { method: 'GET' }, options);
  const list = Array.isArray(body)
    ? body
    : body && typeof body === 'object'
      ? (Object.values(body).find(Array.isArray) as unknown[] | undefined) ?? []
      : [];
  const envelopes: Envelope[] = [];
  let unreadable = 0;
  for (const item of list) {
    const parsed = EnvelopeSchema.safeParse(item);
    if (parsed.success) envelopes.push(parsed.data);
    else unreadable++;
  }
  return list.length || Array.isArray(body) ? { envelopes, unreadable } : { envelopes, unreadable, raw: body };
}

/** Post an envelope. No retries: upstream asks for none on 403, and a retried POST is a duplicate message. */
export function postEnvelope(room: string, envelope: Envelope, options: RelayOptions = {}): Promise<unknown> {
  const parsed = EnvelopeSchema.parse(envelope);
  return request(`room/${encodeURIComponent(room)}`, { method: 'POST', body: JSON.stringify(parsed) }, options);
}

/** The command a person can run themselves, with the headers the relay needs. */
export function curlCommand(room: string, envelope: Envelope, base = DEFAULT_RELAY): string {
  const url = relayUrl(base, `room/${encodeURIComponent(room)}`);
  const headers = Object.entries(HEADERS).map(([k, v]) => `-H '${k}: ${v}'`).join(' ');
  return `curl -X POST '${url}' ${headers} -d '${JSON.stringify(envelope)}'`;
}
