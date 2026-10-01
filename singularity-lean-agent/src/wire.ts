/**
 * lean-link/1 — the wire format between Singularity and a lean-worker prover node.
 *
 * lean-worker's `Protocol.Core` models a certified call to a Lean 4 prover: a
 * caller asks a node to prove a goal, re-check a proof artifact or run an
 * executable the prover built, and the answer comes back as a certificate under
 * the node's tag. The model's tag is idealised (it literally carries the key).
 * This file is the concrete instantiation: the same records, a byte-exact
 * canonical encoding, and HMAC-SHA256 over it, which is also what lean-worker's
 * own proxy wrapper uses for its receipts.
 *
 * The encoding is length-prefixed (`<utf8 bytes>:<text>,` per field) rather than
 * the pipe-joined lines the upstream proxy uses, because a module name or a
 * failure reason containing `|` would make a pipe-joined line ambiguous, and an
 * ambiguous line is two payloads under one tag. `lean/SingularityLean/Wire.lean`
 * defines the same encoding and pins it with kernel-checked vectors;
 * `test/vectors.test.ts` holds this file to those vectors and to
 * `vectors/link-v1.json`. Change one and the others go red.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

export const LINK_VERSION = 'lean-link/1';

/** lean-worker commit this interface was written and checked against. */
export const UPSTREAM = {
  repo: 'https://github.com/meta-introspector/lean-worker',
  commit: '6391a9070b19e0591f16afeed46714ef225b611e',
  committed: '2026-09-20T08:53:14-04:00',
  toolchain: 'leanprover/lean4:v4.28.0',
} as const;

export type PeerId = string;

export type Job =
  | { kind: 'proveGoal'; module: string; decl: string; sourceDigest: string }
  | { kind: 'checkProof'; artifactDigest: string }
  | { kind: 'runExe'; exe: string; argvDigest: string };

export type Outcome =
  | { kind: 'proved'; axioms: string[] }
  | { kind: 'failed'; reason: string }
  | { kind: 'exited'; code: number; outDigest: string };

export interface CallBody {
  client: PeerId;
  server: PeerId;
  nonce: number;
  job: Job;
  /** Seconds of wall-clock time the caller allows the job. */
  fuelBudget: number;
}

export interface Tag {
  signer: PeerId;
  /** Lowercase hex HMAC-SHA256 of the canonical encoding of the payload. */
  mac: string;
}

export interface Call {
  body: CallBody;
  auth: Tag;
  /** Only for `runExe`: the arguments whose digest is `job.argvDigest`. Not covered by the tag; the digest is. */
  argv?: string[];
}

export interface Certificate {
  server: PeerId;
  client: PeerId;
  nonce: number;
  job: Job;
  outcome: Outcome;
  /** True exactly when the Lean kernel accepted the result. */
  kernelChecked: boolean;
  fuelUsed: number;
}

export type Response =
  | { kind: 'rejected'; reason: string }
  | { kind: 'certified'; cert: Certificate; tag: Tag };

// ---------------------------------------------------------------------------
// Canonical encoding
// ---------------------------------------------------------------------------

/** One length-prefixed field: `<utf8 byte length>:<text>,`. */
export function field(text: string): string {
  return `${Buffer.byteLength(text, 'utf8')}:${text},`;
}

function nat(n: number): string {
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError(`not a natural number: ${n}`);
  return field(String(n));
}

export function encodeJob(job: Job): string {
  switch (job.kind) {
    case 'proveGoal':
      return field('proveGoal') + field(job.module) + field(job.decl) + field(job.sourceDigest);
    case 'checkProof':
      return field('checkProof') + field(job.artifactDigest);
    case 'runExe':
      return field('runExe') + field(job.exe) + field(job.argvDigest);
  }
}

export function encodeOutcome(outcome: Outcome): string {
  switch (outcome.kind) {
    case 'proved':
      return field('proved') + nat(outcome.axioms.length) + outcome.axioms.map(field).join('');
    case 'failed':
      return field('failed') + field(outcome.reason);
    case 'exited':
      return field('exited') + nat(outcome.code) + field(outcome.outDigest);
  }
}

export function encodeCallBody(body: CallBody): string {
  return (
    field(LINK_VERSION) + field('call') +
    field(body.client) + field(body.server) + nat(body.nonce) +
    encodeJob(body.job) + nat(body.fuelBudget)
  );
}

export function encodeCertificate(cert: Certificate): string {
  return (
    field(LINK_VERSION) + field('cert') +
    field(cert.server) + field(cert.client) + nat(cert.nonce) +
    encodeJob(cert.job) + encodeOutcome(cert.outcome) +
    field(cert.kernelChecked ? '1' : '0') + nat(cert.fuelUsed)
  );
}

/** The digest `runExe` carries for its argument vector. */
export function encodeArgv(argv: string[]): string {
  return nat(argv.length) + argv.map(field).join('');
}

// ---------------------------------------------------------------------------
// Digests and tags
// ---------------------------------------------------------------------------

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

export function argvDigest(argv: string[]): string {
  return sha256Hex(encodeArgv(argv));
}

const HEX_KEY = /^[0-9a-f]{64}$/;

/** Keys are 32 bytes, written as 64 lowercase hex characters. */
export function keyBytes(hexKey: string): Buffer {
  if (!HEX_KEY.test(hexKey)) throw new RangeError('a lean-link key is 64 lowercase hex characters (32 bytes)');
  return Buffer.from(hexKey, 'hex');
}

export function macHex(hexKey: string, encoded: string): string {
  return createHmac('sha256', keyBytes(hexKey)).update(encoded, 'utf8').digest('hex');
}

export function tagCallBody(signer: PeerId, hexKey: string, body: CallBody): Tag {
  return { signer, mac: macHex(hexKey, encodeCallBody(body)) };
}

export function tagCertificate(signer: PeerId, hexKey: string, cert: Certificate): Tag {
  return { signer, mac: macHex(hexKey, encodeCertificate(cert)) };
}

/** Constant-time comparison of a received tag against the one the key would produce. */
export function verifyTag(signer: PeerId, hexKey: string, encoded: string, tag: Tag): boolean {
  if (tag.signer !== signer || !/^[0-9a-f]{64}$/.test(tag.mac)) return false;
  const expected = Buffer.from(macHex(hexKey, encoded), 'hex');
  return timingSafeEqual(expected, Buffer.from(tag.mac, 'hex'));
}

// ---------------------------------------------------------------------------
// Parsing — everything arriving from the network goes through these
// ---------------------------------------------------------------------------

const peer = z.string().min(1).max(128);
const digest = z.string().regex(/^[0-9a-f]{64}$/, 'a SHA-256 digest in lowercase hex');
const natural = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const leanName = z.string().min(1).max(512);

export const JobSchema: z.ZodType<Job> = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('proveGoal'), module: leanName, decl: leanName, sourceDigest: digest }).strict(),
  z.object({ kind: z.literal('checkProof'), artifactDigest: digest }).strict(),
  z.object({ kind: z.literal('runExe'), exe: z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/), argvDigest: digest }).strict(),
]);

export const OutcomeSchema: z.ZodType<Outcome> = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('proved'), axioms: z.array(leanName).max(256) }).strict(),
  z.object({ kind: z.literal('failed'), reason: z.string().max(4096) }).strict(),
  z.object({ kind: z.literal('exited'), code: natural, outDigest: digest }).strict(),
]);

export const TagSchema: z.ZodType<Tag> = z.object({ signer: peer, mac: z.string().regex(/^[0-9a-f]{64}$/) }).strict();

export const CallBodySchema: z.ZodType<CallBody> = z
  .object({ client: peer, server: peer, nonce: natural, job: JobSchema, fuelBudget: natural })
  .strict();

export const CallSchema: z.ZodType<Call> = z
  .object({ body: CallBodySchema, auth: TagSchema, argv: z.array(z.string().max(4096)).max(256).optional() })
  .strict();

export const CertificateSchema: z.ZodType<Certificate> = z
  .object({
    server: peer,
    client: peer,
    nonce: natural,
    job: JobSchema,
    outcome: OutcomeSchema,
    kernelChecked: z.boolean(),
    fuelUsed: natural,
  })
  .strict();

export const ResponseSchema: z.ZodType<Response> = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('rejected'), reason: z.string().max(4096) }).strict(),
  z.object({ kind: z.literal('certified'), cert: CertificateSchema, tag: TagSchema }).strict(),
]);

/** What travels over HTTP, both ways: the version travels with every message. */
export const CallEnvelopeSchema = z.object({ v: z.literal(LINK_VERSION), call: CallSchema }).strict();
export const ResponseEnvelopeSchema = z.object({ v: z.literal(LINK_VERSION), response: ResponseSchema }).strict();
